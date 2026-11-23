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
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
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
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});
function isValidAdminPassword(password) {
  if (!ADMIN_PASSWORD || !password) {
    return false;
  }

  const expected = Buffer.from(ADMIN_PASSWORD);
  const provided = Buffer.from(password);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Creator Messages"');
    return res.status(401).json({ error: 'Admin access required.' });
  }

  try {
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const username = separator === -1 ? '' : decoded.slice(0, separator);
    const password = separator === -1 ? '' : decoded.slice(separator + 1);

    if (username === 'admin' && isValidAdminPassword(password)) {
      return next();
    }
  } catch {
    // Invalid authorization headers are rejected below.
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Creator Messages"');
  return res.status(401).json({ error: 'Invalid admin credentials.' });
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
    } catch {}
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
  if (!ADMIN_PASSWORD) return null;
  return crypto.createHash('sha256').update(`admin_token:${ADMIN_PASSWORD}`).digest('hex');
}

function isAuthorizedAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
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

  return false;
}

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not configured; admin access is disabled.');
}

app.get(['/admin', '/admin.html', '/admin/*'], requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(__dirname));

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
  res.json({ ok: true });
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

async function saveNowPlaying(trackData) {
  memoryNowPlaying = trackData;
  if (!database) return;

  try {
    await database.query(`
      INSERT INTO now_playing (id, source, title, artist, album, artwork_url, track_url, duration_ms, started_at, ends_at, is_playing, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
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
      trackData.isPlaying !== false
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
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

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

    return {
      isPlaying: true,
      source: 'Spotify',
      title: item.name,
      artist: (item.artists || []).map(a => a.name).join(', '),
      album: item.album ? item.album.name : '',
      artworkUrl: item.album && item.album.images && item.album.images[0] ? item.album.images[0].url : '',
      url: item.external_urls ? item.external_urls.spotify : '',
      timestamps: { start, end },
      durationMs
    };
  } catch (err) {
    console.error('Spotify currently-playing error:', err.message);
    return null;
  }
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
    const album = (current.album && current.album['#text'] ? current.album['#text'] : '').trim();
    const images = current.image || [];
    const artworkUrl = (images.find(img => img.size === 'extralarge') || images.find(img => img.size === 'large') || images[images.length - 1] || {})['#text'] || '';
    const trackUrl = current.url || `https://www.google.com/search?q=${encodeURIComponent(`${title} ${artist}`)}`;

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
  const configuredSecret = process.env.NOW_PLAYING_SECRET || process.env.ADMIN_PASSWORD;

  if (configuredSecret && secret !== configuredSecret) {
    return res.status(401).json({ error: 'Unauthorized. Provide valid secret or API key.' });
  }

  const {
    source = 'Music',
    title,
    artist = '',
    album = '',
    artworkUrl = '',
    url = '',
    duration = 0,
    isPlaying = true
  } = req.body || {};

  if (isPlaying && !title) {
    return res.status(400).json({ error: 'Track title is required when isPlaying is true.' });
  }

  const durationMs = Number(duration) > 0 ? Number(duration) * 1000 : 0;
  const now = Date.now();
  const trackData = {
    isPlaying: Boolean(isPlaying),
    source: String(source).trim() || 'Music',
    title: String(title || '').trim(),
    artist: String(artist || '').trim(),
    album: String(album || '').trim(),
    artworkUrl: String(artworkUrl || '').trim(),
    url: String(url || '').trim(),
    durationMs,
    timestamps: (durationMs > 0 && isPlaying) ? { start: now, end: now + durationMs } : null,
    updatedAtMs: now
  };

  await saveNowPlaying(trackData);
  return res.json({ success: true, track: trackData });
});

app.delete('/api/now-playing', async (req, res) => {
  const secret = req.headers['x-api-key'] || req.body?.secret || req.query?.secret;
  const configuredSecret = process.env.NOW_PLAYING_SECRET || process.env.ADMIN_PASSWORD;

  if (configuredSecret && secret !== configuredSecret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  await saveNowPlaying({ isPlaying: false, title: '', updatedAtMs: Date.now() });
  return res.json({ success: true, message: 'Now playing cleared.' });
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

  // 3. Last.fm API (if configured or passed as ?lastfm=username)
  const lastFmUser = req.query.lastfm || req.query.lastfm_user || process.env.LASTFM_USER;
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
    const discordRes = await fetch('https://api.lanyard.rest/v1/users/772073053097033741', { cache: 'no-store' });
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

  return res.json({
    isPlaying: false,
    message: 'Not currently playing on Spotify, YouTube Music, or BitChord',
    supportedSources: ['Spotify', 'YouTube Music', 'BitChord'],
    endpoints: {
      postUpdate: 'POST /api/now-playing',
      directGet: 'GET /api/now-playing'
    }
  });
});

async function loadStoredProfile() {
  if (database) {
    try {
      const res = await database.query('SELECT data FROM profile_data WHERE id = $1', ['current']);
      if (res.rows.length > 0) {
        return res.rows[0].data;
      }
    } catch (err) {
      console.error('Unable to load profile from database:', err.message);
    }
  }

  if (fs.existsSync(profileFile)) {
    try {
      return JSON.parse(fs.readFileSync(profileFile, 'utf8'));
    } catch {}
  }

  return memoryProfileData;
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
  } catch {}
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
