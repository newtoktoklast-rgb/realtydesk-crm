const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { connectDb } = require('./config/db');

const authRoutes = require('./routes/auth');
const ownerRoutes = require('./routes/owner');
const telegramAccountRoutes = require('./routes/telegramAccounts');
const syncRoutes = require('./routes/sync');
const chatRoutes = require('./routes/chats');
const contactRoutes = require('./routes/contacts');
const templateRoutes = require('./routes/templates');
const updatesRoutes = require('./routes/updates');

const allowedOrigin = process.env.CORS_ORIGIN || process.env.CLIENT_ORIGIN;

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors(allowedOrigin ? { origin: allowedOrigin, credentials: true } : undefined));
  // Ensure DB is connected (cached) before handling any request — important on serverless cold starts.
  app.use(async (req, res, next) => {
    // The update manifest endpoint must stay available even if the DB is down.
    if (req.path.startsWith('/api/v1/updates')) return next();
    try {
      await connectDb();
      next();
    } catch (err) {
      console.error('[db] Connection failed:', err && err.message ? err.message : err);
      res.status(503).json({ error: 'Database unavailable: ' + (err && err.message ? err.message : 'unknown') });
    }
  });
  // mediaRef data URLs (photos) are stored on messages; keep the cap generous
  // but finite (MongoDB's default max document size is 16 MB).
  app.use(express.json({ limit: '16mb' }));
  app.use(morgan('tiny'));

  app.get('/', (req, res) => res.json({ ok: true, service: 'realtydesk-server', version: '0.1.0' }));
  app.get('/health', (req, res) => res.json({ ok: true, service: 'realtydesk-server' }));

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/owner', ownerRoutes);
  app.use('/api/v1/telegram-accounts', telegramAccountRoutes);
  app.use('/api/v1/sync', syncRoutes);
  app.use('/api/v1/chats', chatRoutes);
  app.use('/api/v1/contacts', contactRoutes);
  app.use('/api/v1/templates', templateRoutes);
app.use('/api/v1/updates', updatesRoutes);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };