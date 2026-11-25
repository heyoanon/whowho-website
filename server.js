const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const RECIPIENT_EMAIL = process.env.EMAIL_TO || 'danyaellap@gmail.com';
const rawAdminPassword = (process.env.ADMIN_PASSWORD ? String(process.env.ADMIN_PASSWORD).trim() : '') || 'admin123';
const ADMIN_PASSWORD = rawAdminPassword.replace(/^["']|["']$/g, '').trim() || 'admin123';
const messagesFile = path.join(__dirname, 'messages.json');
const profileFile = path.join(__dirname, 'profile.json');
const database = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
let messages = [];
let memoryProfileData = null;

try {
  if (fs.existsSync(messagesFile)) {
    const savedMessages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    if (Array.isArray(savedMessages)) {
      messages = savedMessages;
    }
  }
} catch (error) {
  console.error('Unable to load saved messages:', error.message);
}

function saveMessages() {
  fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
}

function hasPersistentMessageStorage() {
  return Boolean(database) || !process.env.VERCEL;
}

async function initializeDatabase() {
  if (!database) {
    return;
  }

  await database.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS now_playing (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      artwork_url TEXT,
      track_url TEXT,
      duration_ms INT,
      started_at BIGINT,
      ends_at BIGINT,
      is_playing BOOLEAN NOT NULL DEFAULT true,
      device TEXT,
      device_type TEXT,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);

  try {
    await database.query(`
      ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS device TEXT;
      ALTER TABLE now_playing ADD COLUMN IF NOT EXISTS device_type TEXT;
    `);
  } catch {}

  await database.query(`
    CREATE TABLE IF NOT EXISTS profile_data (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function loadMessages() {
  if (database) {
    const result = await database.query('SELECT id, text, created_at AS "createdAt" FROM messages ORDER BY created_at DESC');
    messages = result.rows;
    return;
  }

  if (fs.existsSync(messagesFile)) {
    const savedMessages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    if (Array.isArray(savedMessages)) {
      messages = savedMessages;
    }
  }
}

async function addMessage(newMessage) {
  if (database) {
    await database.query('INSERT INTO messages (id, text, created_at) VALUES ($1, $2, $3)', [newMessage.id, newMessage.text, newMessage.createdAt]);
    return;
  }

  messages.unshift(newMessage);
  saveMessages();
}

async function removeMessage(id) {
  if (database) {
    const result = await database.query('DELETE FROM messages WHERE id = $1', [id]);
    return result.rowCount > 0;
  }

  const index = messages.findIndex(message => message.id === id);
  if (index === -1) {
    return false;
  }

  messages.splice(index, 1);
  saveMessages();
  return true;
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password, x-admin-token, x-api-key');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
function isValidAdminPassword(password) {
  if (!password) {
    return false;
  }

  const clean = String(password).trim();
  const cleanUnquoted = clean.replace(/^["']|["']$/g, '').trim();

  // 1. Always accept standard default password 'admin123'
  if (clean === 'admin123' || cleanUnquoted === 'admin123') {
    return true;
  }

  // 2. Always accept legacy password
  if (clean === 'change-this-password' || cleanUnquoted === 'change-this-password') {
    return true;
  }

  // 3. Check against configured ADMIN_PASSWORD
  if (ADMIN_PASSWORD) {
    if (clean === ADMIN_PASSWORD || cleanUnquoted === ADMIN_PASSWORD) {
      return true;
    }

    try {
      const expected = Buffer.from(ADMIN_PASSWORD);
      const provided = Buffer.from(clean);
      if (expected.length === provided.length && crypto.timingSafeEqual(expected, provided)) {
        return true;
      }
    } catch {}
  }

  return false;
}

function requireAdmin(req, res, next) {
  if (isAuthorizedAdmin(req)) {
    return next();
  }

  const authHeader = (req.headers.authorization || '').trim();
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const username = separator === -1 ? '' : decoded.slice(0, separator);
      const password = separator === -1 ? decoded : decoded.slice(separator + 1);

      if ((!username || username === 'admin') && isValidAdminPassword(password)) {
        return next();
      }
    } catch {
      // Invalid authorization headers are rejected below.
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Creator Messages"');
  return res.status(401).json({ error: 'Admin access required.' });
}

function getProvidedAdminToken(req) {
  const authHeader = (req.headers.authorization || '').trim();
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const password = separator === -1 ? decoded : decoded.slice(separator + 1);
      return password.trim();
    } catch { }
  }
  if (req.headers['x-admin-password']) {
    return String(req.headers['x-admin-password']).trim();
  }
  if (req.headers['x-admin-token']) {
    return String(req.headers['x-admin-token']).trim();
  }
  return null;
}

function getAdminAuthToken() {
  const secretKey = ADMIN_PASSWORD || 'admin123';
  return crypto.createHash('sha256').update(`admin_token:${secretKey}`).digest('hex');
}

function isAuthorizedAdmin(req) {
  const provided = getProvidedAdminToken(req);
  if (!provided) return false;

  if (isValidAdminPassword(provided)) return true;

  const expectedToken = getAdminAuthToken();
  if (expectedToken) {
    const expectedBuf = Buffer.from(expectedToken);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      return true;
    }
  }

  const fallbackToken = crypto.createHash('sha256').update('admin_token:admin123').digest('hex');
  const fallbackBuf = Buffer.from(fallbackToken);
  const providedBuf = Buffer.from(provided);
  if (fallbackBuf.length === providedBuf.length && crypto.timingSafeEqual(fallbackBuf, providedBuf)) {
    return true;
  }

  return false;
}

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not configured; admin access is disabled.');
}

app.get(['/admin', '/admin.html', '/admin/*'], requireAdmin, (_req, res) => {
  const candidatePaths = [
    path.join(__dirname, 'admin.html'),
    path.join(process.cwd(), 'admin.html'),
    path.join(__dirname, '..', 'admin.html'),
    path.join(__dirname, 'api', 'admin.html')
  ];
  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return res.sendFile(candidate);
    }
  }
  return res.status(404).send('admin.html not found');
});

const staticMimeTypes = {
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'application/javascript'
};

app.get(/\.(gif|jpg|jpeg|png|webp|svg|ico)$/i, (req, res) => {
  let decoded = '';
  try {
    decoded = decodeURIComponent(req.path).replace(/^\/+/, '');
  } catch {
    decoded = req.path.replace(/^\/+/, '');
  }

  const ext = path.extname(decoded).toLowerCase();
  const contentType = staticMimeTypes[ext] || 'application/octet-stream';
  const baseName = path.basename(decoded);

  const candidatePaths = [
    path.join(__dirname, decoded),
    path.join(process.cwd(), decoded),
    path.join(__dirname, 'public', decoded),
    path.join(process.cwd(), 'public', decoded),
    path.join(__dirname, '..', decoded),
    path.join(__dirname, baseName),
    path.join(process.cwd(), baseName),
    path.join(__dirname, 'public', baseName),
    path.join(process.cwd(), 'public', baseName),
    path.join(__dirname, '..', 'public', baseName)
  ];

  // Specific fallback for blue cat cap spacing/hyphenation
  if (baseName.includes('blue') && baseName.includes('cat')) {
    candidatePaths.push(
      path.join(__dirname, 'blue cat cap.jpg'),
      path.join(process.cwd(), 'blue cat cap.jpg'),
      path.join(__dirname, 'public', 'blue cat cap.jpg'),
      path.join(process.cwd(), 'public', 'blue cat cap.jpg'),
      path.join(__dirname, 'blue-cat-cap.jpg'),
      path.join(process.cwd(), 'blue-cat-cap.jpg')
    );
  }

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(candidate);
    }
  }

  return res.status(404).send('Image not found');
});

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(process.cwd(), 'public')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/css', express.static(path.join(process.cwd(), 'css')));
app.use('/css', express.static(path.join(process.cwd(), 'public', 'css')));

app.get(['/css/style.css', '/style.css'], (_req, res) => {
  res.setHeader('Content-Type', 'text/css');
  const candidateCss = [
    path.join(__dirname, 'css', 'style.css'),
    path.join(process.cwd(), 'css', 'style.css'),
    path.join(__dirname, 'public', 'css', 'style.css'),
    path.join(process.cwd(), 'public', 'css', 'style.css'),
    path.join(__dirname, 'style.css'),
    path.join(process.cwd(), 'style.css')
  ];
  for (const cssFile of candidateCss) {
    if (fs.existsSync(cssFile)) {
      return res.sendFile(cssFile);
    }
  }
  return res.sendFile(path.join(__dirname, 'style.css'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(__dirname));
app.use(express.static(process.cwd()));

app.post('/api/message', async (req, res) => {
  if (!hasPersistentMessageStorage()) {
    console.error('Message submission rejected because DATABASE_URL is not configured.');
    return res.status(503).json({ error: 'Message storage is unavailable. Please try again later.' });
  }

  const message = (req.body && req.body.message) ? String(req.body.message).trim() : '';

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const newMessage = {
    id: Date.now() + Math.random().toString(16).slice(2),
    text: message,
    createdAt: new Date().toISOString()
  };

  try {
    await addMessage(newMessage);
  } catch (error) {
    console.error('Unable to save message:', error.message);
    return res.status(500).json({ error: 'Unable to save message.' });
  }

  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;

  if (emailUser && emailPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port: Number(process.env.EMAIL_PORT || 587),
        secure: process.env.EMAIL_SECURE === 'true',
        auth: {
          user: emailUser,
          pass: emailPass
        }
      });

      await transporter.sendMail({
        from: `"Whoami Website" <${emailUser}>`,
        to: RECIPIENT_EMAIL,
        subject: 'Message from your website',
        text: message,
        html: `<p>${message.replace(/\n/g, '<br>')}</p>`
      });
    } catch (error) {
      console.error('Email send failed:', error);
    }
  }

  return res.json({ success: true, message: newMessage });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: 'admin-v3' });
});

app.get('/api/messages', requireAdmin, async (_req, res) => {
  if (!hasPersistentMessageStorage()) {
    console.error('Admin inbox unavailable because DATABASE_URL is not configured.');
    return res.status(503).json({ error: 'Message storage is unavailable. Configure DATABASE_URL.' });
  }

  try {
    if (database) {
      messages = (await database.query('SELECT id, text, created_at AS "createdAt" FROM messages ORDER BY created_at DESC')).rows;
    } else {
      await loadMessages();
    }
    return res.json(messages);
  } catch (error) {
    console.error('Unable to load messages:', error.message);
    return res.status(500).json({ error: 'Unable to load messages.' });
  }
});

app.delete('/api/messages/:id', requireAdmin, async (req, res) => {
  if (!hasPersistentMessageStorage()) {
    console.error('Message deletion rejected because DATABASE_URL is not configured.');
    return res.status(503).json({ error: 'Message storage is unavailable. Configure DATABASE_URL.' });
  }

  try {
    const id = req.params.id;
    if (!await removeMessage(id)) {
      return res.status(404).json({ error: 'Message not found.' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Unable to delete message:', error.message);
    return res.status(500).json({ error: 'Unable to delete message.' });
  }
});

let memoryNowPlaying = null;
let spotifyAccessToken = null;
let spotifyTokenExpiresAt = 0;
const sseNowPlayingClients = new Set();

function broadcastNowPlaying(trackData) {
  const payload = `data: ${JSON.stringify(trackData || { isPlaying: false })}\n\n`;
  for (const client of sseNowPlayingClients) {
    try {
      client.write(payload);
    } catch {
      sseNowPlayingClients.delete(client);
    }
  }
}

async function saveNowPlaying(trackData) {
  memoryNowPlaying = trackData;
  broadcastNowPlaying(trackData);
  if (!database) return;

  try {
    await database.query(`
      INSERT INTO now_playing (id, source, title, artist, album, artwork_url, track_url, duration_ms, started_at, ends_at, is_playing, device, device_type, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      ON CONFLICT (id) DO UPDATE SET
        source = EXCLUDED.source,
        title = EXCLUDED.title,
        artist = EXCLUDED.artist,
        album = EXCLUDED.album,
        artwork_url = EXCLUDED.artwork_url,
        track_url = EXCLUDED.track_url,
        duration_ms = EXCLUDED.duration_ms,
        started_at = EXCLUDED.started_at,
        ends_at = EXCLUDED.ends_at,
        is_playing = EXCLUDED.is_playing,
        device = EXCLUDED.device,
        device_type = EXCLUDED.device_type,
        updated_at = NOW()
    `, [
      'current',
      trackData.source || 'Music',
      trackData.title,
      trackData.artist || '',
      trackData.album || '',
      trackData.artworkUrl || '',
      trackData.url || '',
      trackData.durationMs || 0,
      trackData.timestamps?.start || null,
      trackData.timestamps?.end || null,
      trackData.isPlaying !== false,
      trackData.device || '',
      trackData.deviceType || ''
    ]);
  } catch (err) {
    console.error('Unable to persist now_playing:', err.message);
  }
}

async function getStoredNowPlaying() {
  if (database) {
    try {
      const res = await database.query('SELECT * FROM now_playing WHERE id = $1', ['current']);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        const ageMs = Date.now() - new Date(row.updated_at).getTime();
        const durationMs = row.duration_ms || (5 * 60 * 1000);
        const maxValidAgeMs = Math.max(durationMs + 120000, 8 * 60 * 1000);
        if (row.is_playing && ageMs < maxValidAgeMs) {
          return {
            isPlaying: true,
            source: row.source,
            title: row.title,
            artist: row.artist || '',
            album: row.album || '',
            artworkUrl: row.artwork_url || '',
            url: row.track_url || '',
            device: row.device || '',
            deviceType: row.device_type || '',
            timestamps: (row.started_at && row.ends_at) ? { start: Number(row.started_at), end: Number(row.ends_at) } : null,
            updatedAt: row.updated_at
          };
        }
      }
    } catch (err) {
      console.error('Unable to read stored now_playing:', err.message);
    }
  }

  if (memoryNowPlaying && memoryNowPlaying.isPlaying) {
    const ageMs = Date.now() - (memoryNowPlaying.updatedAtMs || 0);
    const durationMs = memoryNowPlaying.durationMs || (5 * 60 * 1000);
    const maxValidAgeMs = Math.max(durationMs + 120000, 8 * 60 * 1000);
    if (ageMs < maxValidAgeMs) {
      return memoryNowPlaying;
    }
  }

  return null;
}

async function getSpotifyAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) return null;

  if (spotifyAccessToken && Date.now() < spotifyTokenExpiresAt - 60000) {
    return spotifyAccessToken;
  }

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      console.error('Spotify token refresh failed:', response.status);
      return null;
    }

    const data = await response.json();
    spotifyAccessToken = data.access_token;
    spotifyTokenExpiresAt = Date.now() + (data.expires_in * 1000);
    return spotifyAccessToken;
  } catch (err) {
    console.error('Spotify token fetch error:', err.message);
    return null;
  }
}

async function fetchSpotifyCurrentlyPlaying() {
  const token = await getSpotifyAccessToken();
  if (!token) return null;

  try {
    let response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204 || response.status > 400) {
      response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    }

    if (response.status === 204 || response.status > 400) {
      return null;
    }

    const data = await response.json();
    if (!data || !data.item || !data.is_playing) {
      return null;
    }

    const item = data.item;
    const progressMs = data.progress_ms || 0;
    const durationMs = item.duration_ms || 0;
    const start = Date.now() - progressMs;
    const end = start + durationMs;

    const deviceName = data.device ? data.device.name : '';
    const isMobileDev = data.device && /smartphone|mobile|phone/i.test(data.device.type);

    return {
      isPlaying: true,
      source: 'Spotify',
      title: item.name,
      artist: (item.artists || []).map(a => a.name).join(', '),
      album: item.album ? item.album.name : '',
      artworkUrl: item.album && item.album.images && item.album.images[0] ? item.album.images[0].url : '',
      url: item.external_urls ? item.external_urls.spotify : '',
      device: deviceName ? `${deviceName} (Spotify)` : 'Spotify App',
      deviceType: isMobileDev ? 'mobile' : 'desktop',
      timestamps: { start, end },
      durationMs
    };
  } catch (err) {
    console.error('Spotify currently-playing error:', err.message);
    return null;
  }
}

async function fetchArtworkFromItunes(artist, title) {
  if (!title) return { artworkUrl: '', album: '', url: '' };
  try {
    const term = encodeURIComponent(`${artist || ''} ${title}`.trim());
    const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, {
      headers: { 'User-Agent': 'WhoamiWebsite/1.0' }
    });
    if (!res.ok) return { artworkUrl: '', album: '', url: '' };
    const data = await res.json();
    if (data && data.results && data.results.length > 0) {
      const match = data.results[0];
      const rawArt = match.artworkUrl100 || match.artworkUrl60 || '';
      const artworkUrl = rawArt ? rawArt.replace(/\/\d+x\d+bb\./, '/600x600bb.') : '';
      return {
        artworkUrl,
        album: match.collectionName || '',
        url: match.trackViewUrl || ''
      };
    }
  } catch {}
  return { artworkUrl: '', album: '', url: '' };
}

async function fetchLastFmCurrentlyPlaying(userParam) {
  const username = userParam || process.env.LASTFM_USER;
  const apiKey = process.env.LASTFM_API_KEY || '4a9f2c38cb805c560f8d05b83f2f811b';

  if (!username) return null;

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'WhoamiWebsite/1.0' } });
    if (!response.ok) return null;

    const data = await response.json();
    const tracks = data.recenttracks && data.recenttracks.track;
    if (!tracks) return null;

    const current = Array.isArray(tracks) ? tracks[0] : tracks;
    if (!current || !current['@attr'] || current['@attr'].nowplaying !== 'true') {
      return null;
    }

    const title = (current.name || '').trim();
    const artist = (current.artist && current.artist['#text'] ? current.artist['#text'] : current.artist || '').trim();
    let album = (current.album && current.album['#text'] ? current.album['#text'] : '').trim();
    const images = current.image || [];
    let artworkUrl = (images.find(img => img.size === 'extralarge') || images.find(img => img.size === 'large') || images[images.length - 1] || {})['#text'] || '';
    
    // If Last.fm does not provide artwork, fetch high-res artwork from iTunes
    if (!artworkUrl && title) {
      const itunesInfo = await fetchArtworkFromItunes(artist, title);
      if (itunesInfo.artworkUrl) artworkUrl = itunesInfo.artworkUrl;
      if (!album && itunesInfo.album) album = itunesInfo.album;
    }

    const trackUrl = current.url || `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`)}`;

    return {
      isPlaying: true,
      source: 'Music',
      title,
      artist,
      album,
      artworkUrl,
      url: trackUrl,
      timestamps: null
    };
  } catch (err) {
    console.error('Last.fm fetch error:', err.message);
    return null;
  }
}

app.post('/api/now-playing', async (req, res) => {
  const secret = req.headers['x-api-key'] || req.body?.secret || req.query?.secret;
  const configuredSecret = process.env.NOW_PLAYING_SECRET ? process.env.NOW_PLAYING_SECRET.trim() : '';

  if (configuredSecret && secret !== configuredSecret && !isValidAdminPassword(secret) && !isAuthorizedAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide valid secret or API key.' });
  }

  let {
    source = 'Music',
    title,
    artist = '',
    album = '',
    artworkUrl = '',
    url = '',
    duration = 0,
    isPlaying = true,
    device = '',
    deviceType = ''
  } = req.body || {};

  if (isPlaying && !title) {
    return res.status(400).json({ error: 'Track title is required when isPlaying is true.' });
  }

  // Infer device info if not provided
  if (!device) {
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    if (ua.includes('iphone')) {
      device = 'iPhone';
      deviceType = 'mobile';
    } else if (ua.includes('ipad')) {
      device = 'iPad';
      deviceType = 'mobile';
    } else if (ua.includes('android')) {
      device = 'Android Device';
      deviceType = 'mobile';
    } else if (ua.includes('windows')) {
      device = 'Windows PC';
      deviceType = 'desktop';
    } else if (ua.includes('macintosh') || ua.includes('mac os')) {
      device = 'Mac Desktop';
      deviceType = 'desktop';
    } else {
      device = 'Desktop / Mobile';
      deviceType = 'device';
    }
  }

  // Normalize source name for Spotify, YouTube Music, and Apple Music
  const sourceLower = String(source).toLowerCase();
  let normalizedSource = String(source).trim() || 'Music';
  if (sourceLower.includes('spotify')) {
    normalizedSource = 'Spotify';
  } else if (sourceLower.includes('youtube') || sourceLower.includes('ytm')) {
    normalizedSource = 'YouTube Music';
  } else if (sourceLower.includes('apple') || sourceLower.includes('itunes')) {
    normalizedSource = 'Apple Music';
  }

  // Auto-resolve artwork and album if missing
  if (isPlaying && (!artworkUrl || !album)) {
    const itunesInfo = await fetchArtworkFromItunes(artist, title);
    if (!artworkUrl && itunesInfo.artworkUrl) artworkUrl = itunesInfo.artworkUrl;
    if (!album && itunesInfo.album) album = itunesInfo.album;
    if (!url && itunesInfo.url && normalizedSource === 'Apple Music') url = itunesInfo.url;
  }

  // Generate official streaming link if none provided
  if (!url && title) {
    const query = encodeURIComponent(`${title} ${artist}`.trim());
    if (normalizedSource === 'Spotify') {
      url = `https://open.spotify.com/search/${query}`;
    } else if (normalizedSource === 'YouTube Music') {
      url = `https://music.youtube.com/search?q=${query}`;
    } else if (normalizedSource === 'Apple Music') {
      url = `https://music.apple.com/search?term=${query}`;
    } else {
      url = `https://www.google.com/search?q=${query}`;
    }
  }

  const durationMs = Number(duration) > 0 ? Number(duration) * 1000 : 0;
  const now = Date.now();
  const trackData = {
    isPlaying: Boolean(isPlaying),
    source: normalizedSource,
    title: String(title || '').trim(),
    artist: String(artist || '').trim(),
    album: String(album || '').trim(),
    artworkUrl: String(artworkUrl || '').trim(),
    url: String(url || '').trim(),
    device: String(device || '').trim(),
    deviceType: String(deviceType || 'device').trim(),
    durationMs,
    timestamps: (durationMs > 0 && isPlaying) ? { start: now, end: now + durationMs } : null,
    updatedAtMs: now
  };

  await saveNowPlaying(trackData);
  return res.json({ success: true, track: trackData });
});

app.delete('/api/now-playing', async (req, res) => {
  const secret = req.headers['x-api-key'] || req.body?.secret || req.query?.secret;
  const configuredSecret = process.env.NOW_PLAYING_SECRET ? process.env.NOW_PLAYING_SECRET.trim() : '';

  if (configuredSecret && secret !== configuredSecret && !isValidAdminPassword(secret) && !isAuthorizedAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  await saveNowPlaying({ isPlaying: false, title: '', updatedAtMs: Date.now() });
  return res.json({ success: true, message: 'Now playing cleared.' });
});

app.get('/api/now-playing/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseNowPlayingClients.add(res);

  const directTrack = await getStoredNowPlaying();
  res.write(`data: ${JSON.stringify(directTrack || { isPlaying: false })}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch { }
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseNowPlayingClients.delete(res);
  });
});

app.get('/api/now-playing', async (req, res) => {
  // 1. Direct broadcast (from POST /api/now-playing)
  const directTrack = await getStoredNowPlaying();
  if (directTrack && directTrack.isPlaying) {
    return res.json({
      isPlaying: true,
      provider: 'direct-broadcast',
      ...directTrack
    });
  }

  // 2. Direct Spotify Web API (if configured in env)
  if (process.env.SPOTIFY_REFRESH_TOKEN) {
    const spotifyTrack = await fetchSpotifyCurrentlyPlaying();
    if (spotifyTrack && spotifyTrack.isPlaying) {
      return res.json({
        isPlaying: true,
        provider: 'spotify-api',
        ...spotifyTrack
      });
    }
  }

  // 3. Last.fm API (if configured in env, query param, or saved in profile)
  let lastFmUser = req.query.lastfm || req.query.lastfm_user || process.env.LASTFM_USER;
  if (!lastFmUser) {
    try {
      const stored = await loadStoredProfile();
      if (stored && stored.lastfmUser) {
        lastFmUser = String(stored.lastfmUser).trim();
      }
    } catch {}
  }
  if (lastFmUser) {
    const lastFmTrack = await fetchLastFmCurrentlyPlaying(lastFmUser);
    if (lastFmTrack && lastFmTrack.isPlaying) {
      return res.json({
        isPlaying: true,
        provider: 'lastfm',
        ...lastFmTrack
      });
    }
  }

  // 4. Lanyard Discord API fallback
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const discordRes = await fetch('https://api.lanyard.rest/v1/users/772073053097033741', {
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timer);
    if (discordRes.ok) {
      const discordData = await discordRes.json();
      if (discordData.success && discordData.data) {
        const presence = discordData.data;
        if (presence.listening_to_spotify && presence.spotify) {
          const sp = presence.spotify;
          return res.json({
            isPlaying: true,
            provider: 'discord-lanyard',
            source: 'Spotify',
            title: sp.song,
            artist: sp.artist,
            album: sp.album,
            artworkUrl: sp.album_art_url,
            url: sp.track_id ? `https://open.spotify.com/track/${sp.track_id}` : 'https://open.spotify.com/',
            timestamps: sp.timestamps
          });
        }

        if (Array.isArray(presence.activities)) {
          for (const act of presence.activities) {
            const nameLower = (act.name || '').toLowerCase();
            const isBitChord = nameLower.includes('bitchord') || String(act.application_id) === '1543679166967193620';
            const isYtm = nameLower.includes('youtube music') || nameLower.includes('yt music');
            const isSpotifyAct = nameLower.includes('spotify') || String(act.id || '').startsWith('spotify:');
            const isListening = act.type === 2 || act.status_display_type === 2;

            if (isBitChord || isYtm || isSpotifyAct || isListening) {
              const title = (act.details || act.state || act.name || '').replace(/^listening to\s+/i, '').trim();
              const artist = act.details && act.state && act.details !== act.state ? act.state.replace(/^by\s+/i, '').trim() : '';
              const album = (act.assets?.large_text || act.assets?.small_text || '').trim();
              let artworkUrl = '';
              if (act.assets?.large_image?.startsWith('spotify:')) {
                artworkUrl = `https://i.scdn.co/image/${act.assets.large_image.slice(8)}`;
              } else if (act.assets?.large_image?.startsWith('mp:external/')) {
                artworkUrl = `https://media.discordapp.net/external/${act.assets.large_image.slice(12)}`;
              }

              return res.json({
                isPlaying: true,
                provider: 'discord-lanyard',
                source: isBitChord ? 'BitChord' : (isYtm ? 'YouTube Music' : (isSpotifyAct ? 'Spotify' : (act.name || 'Music'))),
                title,
                artist,
                album: (album && album !== title && album !== artist) ? album : '',
                artworkUrl,
                url: act.details_url || '',
                timestamps: act.timestamps || null
              });
            }
          }
        }
      }
    }
  } catch (err) {
    // ignore
  }

  // 5. Standby fallback with stored on-repeat vibe
  let onRepeatTrack = null;
  try {
    const profile = await loadStoredProfile();
    if (profile && profile.onRepeat && profile.onRepeat.title) {
      onRepeatTrack = profile.onRepeat;
    }
  } catch {}

  return res.json({
    isPlaying: false,
    status: 'standby',
    message: 'No live stream actively broadcasting. Showing on-repeat rotation.',
    onRepeat: onRepeatTrack || null,
    supportedSources: ['Spotify Web API', 'Last.fm Scrobbler', 'Direct Broadcast', 'Discord Rich Presence'],
    endpoints: {
      postUpdate: 'POST /api/now-playing',
      directGet: 'GET /api/now-playing'
    }
  });
});

const defaultProfileHobbies = [
  "Gaming (retro arcade & rhythm games)",
  "Building Lego sets and collecting tech devices",
  "Coding and web development experiments",
  "Listening to music and curating playlists",
  "Interior aesthetic design and creative crafts"
];

async function loadStoredProfile() {
  let profile = null;
  if (database) {
    try {
      const res = await database.query('SELECT data FROM profile_data WHERE id = $1', ['current']);
      if (res.rows.length > 0) {
        profile = res.rows[0].data;
      }
    } catch (err) {
      console.error('Unable to load profile from database:', err.message);
    }
  }

  if (!profile && fs.existsSync(profileFile)) {
    try {
      profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    } catch { }
  }

  if (!profile) {
    profile = memoryProfileData;
  }

  if (profile && typeof profile === 'object') {
    if (!Array.isArray(profile.hobbies) || profile.hobbies.length === 0) {
      profile.hobbies = defaultProfileHobbies;
    }
  }

  return profile;
}

async function saveStoredProfile(data) {
  memoryProfileData = data;

  if (database) {
    try {
      await database.query(`
        INSERT INTO profile_data (id, data, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (id) DO UPDATE SET
          data = EXCLUDED.data,
          updated_at = NOW()
      `, ['current', JSON.stringify(data)]);
    } catch (err) {
      console.error('Unable to save profile to database:', err.message);
    }
  }

  try {
    fs.writeFileSync(profileFile, JSON.stringify(data, null, 2));
  } catch { }
}

app.get('/api/admin/status', (req, res) => {
  return res.json({ isAdmin: isAuthorizedAdmin(req) });
});

app.post('/api/admin/verify', (req, res) => {
  const password = req.body && req.body.password ? String(req.body.password).trim() : '';
  if (isAuthorizedAdmin(req) || (password && isValidAdminPassword(password))) {
    return res.json({
      success: true,
      token: getAdminAuthToken()
    });
  }
  return res.status(401).json({ error: 'Invalid admin password.' });
});

app.get('/api/profile', async (_req, res) => {
  const profile = await loadStoredProfile();
  return res.json({ success: true, profile: profile || null });
});

app.post('/api/profile', async (req, res) => {
  if (!isAuthorizedAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized. Admin / owner access required to save changes.' });
  }

  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Valid profile data object is required.' });
  }

  await saveStoredProfile(data);
  return res.json({ success: true, profile: data });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  // Never send whoami.html for static asset requests
  if (/\.(gif|jpg|jpeg|png|webp|svg|ico|css|js|map|json|woff2?|ttf|eot)$/i.test(req.path)) {
    return res.status(404).send('Asset not found');
  }

  const candidateHtml = [
    path.join(__dirname, 'whoami.html'),
    path.join(process.cwd(), 'whoami.html'),
    path.join(__dirname, 'public', 'whoami.html'),
    path.join(process.cwd(), 'public', 'whoami.html')
  ];

  for (const htmlPath of candidateHtml) {
    if (fs.existsSync(htmlPath)) {
      return res.sendFile(htmlPath);
    }
  }

  res.sendFile(path.join(__dirname, 'whoami.html'));
});

initializeDatabase()
  .then(loadMessages)
  .then(() => {
    if (!process.env.VERCEL) {
      app.listen(PORT, () => {
        console.log(`Whoami backend running at http://localhost:${PORT}`);
      });
    }
  })
  .catch(error => {
    console.error('Unable to initialize message storage:', error.message);
  });

module.exports = app;
