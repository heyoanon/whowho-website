const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const RECIPIENT_EMAIL = process.env.EMAIL_TO || 'danyaellap@gmail.com';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'admin123').trim();
const LEGACY_ADMIN_PASSWORDS = new Set(['admin123', 'change-this-password']);
const messages = [];

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
app.use(express.static(__dirname));

function isValidAdminPassword(password) {
  if (!password) {
    return false;
  }

  if (password === ADMIN_PASSWORD) {
    return true;
  }

  return !process.env.ADMIN_PASSWORD && LEGACY_ADMIN_PASSWORDS.has(password);
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Creator Messages"');
    return res.status(401).json({ error: 'Admin access required.' });
  }

  try {
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString('utf8');
    const [username, password] = decoded.split(':');

    if (username === 'admin' && isValidAdminPassword(password)) {
      return next();
    }
  } catch (error) {
    // ignore
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Creator Messages"');
  return res.status(401).json({ error: 'Invalid admin credentials.' });
}

app.post('/api/message', async (req, res) => {
  const message = (req.body && req.body.message) ? String(req.body.message).trim() : '';

  if (!message) {
    return res.status(400).json({ error: 'Message is required.' });
  }

  const newMessage = {
    id: Date.now() + Math.random().toString(16).slice(2),
    text: message,
    createdAt: new Date().toISOString()
  };

  messages.unshift(newMessage);

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

app.get('/api/messages', requireAdmin, (_req, res) => {
  res.json(messages);
});

app.delete('/api/messages/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  const index = messages.findIndex(msg => msg.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Message not found.' });
  }

  messages.splice(index, 1);
  return res.json({ success: true });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (req.path.startsWith('/admin')) {
    return res.sendFile(path.join(__dirname, 'admin.html'));
  }

  res.sendFile(path.join(__dirname, 'whoami.html'));
});

app.listen(PORT, () => {
  console.log(`Whoami backend running at http://localhost:${PORT}`);
});
