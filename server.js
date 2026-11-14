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
const database = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
let messages = [];

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
