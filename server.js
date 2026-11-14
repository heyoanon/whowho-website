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
const MUSIC_PRESENCE_TOKEN = (process.env.MUSIC_PRESENCE_TOKEN || '').trim();
const messagesFile = path.join(__dirname, 'messages.json');
const database = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
let messages = [];
const localMusicPresence = new Map();
const MUSIC_PRESENCE_TTL_MS = 30000;

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
    CREATE TABLE IF NOT EXISTS music_presence (
      source TEXT PRIMARY KEY,
      track JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
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

function isValidMusicPresenceToken(token) {
  if (!MUSIC_PRESENCE_TOKEN || !token) {
    return false;
  }

  const expected = Buffer.from(MUSIC_PRESENCE_TOKEN);
  const provided = Buffer.from(token);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

function requireMusicPresenceToken(req, res, next) {
  if (!MUSIC_PRESENCE_TOKEN) {
    return res.status(503).json({ error: 'Music presence publishing is not configured.' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!isValidMusicPresenceToken(token)) {
    return res.status(401).json({ error: 'Invalid music presence token.' });
  }

  return next();
}

function normalizeMusicTrack(body) {
  const source = body && body.source;
  if (source !== 'youtube-music') {
    return { error: 'Only YouTube Music can publish through this endpoint.' };
  }

  if (typeof body.playing !== 'boolean') {
    return { error: 'Playback state is required.' };
  }

  if (body.playing === false) {
    return { source, stopped: true };
  }

  const track = body.track;
  if (!track || typeof track !== 'object' || Array.isArray(track)) {
    return { error: 'Track details are required while playback is active.' };
  }

  const title = typeof track.title === 'string' ? track.title.trim() : '';
  if (!title || title.length > 200) {
    return { error: 'Track title must be between 1 and 200 characters.' };
  }

  const optionalText = (value, label) => {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value.length > 200) {
      throw new Error(`${label} must be 200 characters or fewer.`);
    }
    return value.trim();
  };

  let artworkUrl = '';
  if (track.artworkUrl) {
    if (typeof track.artworkUrl !== 'string') {
      return { error: 'Artwork URL must be a valid HTTP or HTTPS URL.' };
    }
    try {
      const url = new URL(track.artworkUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        return { error: 'Artwork URL must use HTTP or HTTPS.' };
      }
      artworkUrl = url.toString();
    } catch {
      return { error: 'Artwork URL must be a valid HTTP or HTTPS URL.' };
    }
  }

  const timestamps = {};
  const start = Number(track.timestamps && track.timestamps.start);
  const end = Number(track.timestamps && track.timestamps.end);
  if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end > start) {
    timestamps.start = start;
    timestamps.end = end;
  }

  try {
    return {
      source,
      track: {
        source,
        title,
        artist: optionalText(track.artist, 'Artist'),
        album: optionalText(track.album, 'Album'),
        artworkUrl,
        timestamps
      }
    };
  } catch (error) {
    return { error: error.message };
  }
}

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD is not configured; admin access is disabled.');
}

app.get(['/admin', '/admin.html', '/admin/*'], requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(__dirname));

app.get('/api/now-playing', async (_req, res) => {
  if (!hasPersistentMessageStorage()) {
    return res.status(503).json({ error: 'Music presence storage is unavailable. Configure DATABASE_URL.' });
  }

  try {
    let tracks;
    if (database) {
      const result = await database.query(`
        SELECT track
        FROM music_presence
        WHERE updated_at > NOW() - INTERVAL '30 seconds'
        ORDER BY source
      `);
      tracks = result.rows.map(row => row.track);
    } else {
      const now = Date.now();
      tracks = Array.from(localMusicPresence.values())
        .filter(entry => now - entry.updatedAt < MUSIC_PRESENCE_TTL_MS)
        .map(entry => entry.track);
    }

    return res.json({ tracks });
  } catch (error) {
    console.error('Unable to load music presence:', error.message);
    return res.status(500).json({ error: 'Unable to load music presence.' });
  }
});

app.put('/api/now-playing', requireMusicPresenceToken, async (req, res) => {
  if (!hasPersistentMessageStorage()) {
    return res.status(503).json({ error: 'Music presence storage is unavailable. Configure DATABASE_URL.' });
  }

  const normalized = normalizeMusicTrack(req.body);
  if (normalized.error) {
    return res.status(400).json({ error: normalized.error });
  }

  try {
    if (normalized.stopped) {
      if (database) {
        await database.query('DELETE FROM music_presence WHERE source = $1', [normalized.source]);
      } else {
        localMusicPresence.delete(normalized.source);
      }
      return res.json({ success: true });
    }

    if (database) {
      await database.query(`
        INSERT INTO music_presence (source, track, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (source) DO UPDATE
        SET track = EXCLUDED.track, updated_at = NOW()
      `, [normalized.source, JSON.stringify(normalized.track)]);
    } else {
      localMusicPresence.set(normalized.source, { track: normalized.track, updatedAt: Date.now() });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Unable to update music presence:', error.message);
    return res.status(500).json({ error: 'Unable to update music presence.' });
  }
});

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

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(path.join(__dirname, 'whoami.html'));
});

initializeDatabase()
  .then(loadMessages)
  .then(() => app.listen(PORT, () => {
  console.log(`Whoami backend running at http://localhost:${PORT}`);
  }))
  .catch(error => {
    console.error('Unable to initialize message storage:', error.message);
    process.exit(1);
  });
