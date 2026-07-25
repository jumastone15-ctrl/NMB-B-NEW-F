// db.js — MongoDB (Atlas) connection module
// Keeps the connection alive permanently — survives Render deploys,
// Atlas connection resets, and transient network blips.
//
// Key settings:
//   serverSelectionTimeoutMS  — how long to wait when picking a server on first connect
//   heartbeatFrequencyMS      — how often the driver pings Atlas to detect drops early
//   socketTimeoutMS           — abort idle sockets that have gone silent
//   maxPoolSize               — connection pool (5 is fine for a single-process bot)
//   retryWrites / retryReads  — automatic retry on transient write/read errors
//   bufferCommands            — queue Mongoose ops while reconnecting, flush on reconnect

const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS:  10_000,  // fail fast on bad URI / paused cluster at startup
  heartbeatFrequencyMS:      10_000,  // detect drops within 10 s
  socketTimeoutMS:           45_000,  // recycle sockets silent for > 45 s
  maxPoolSize:               5,
  retryWrites:               true,
  retryReads:                true,
  bufferCommands:            true,    // queue ops during brief disconnects
};

// Track whether we are intentionally shutting down so the 'disconnected'
// event knows not to log a misleading "reconnecting" message.
let shuttingDown = false;
const markShutdown = () => { shuttingDown = true; };

// ── Initial connect ──
const connectDB = async () => {
  if (!MONGODB_URI) {
    console.error(
      '[DB] MONGODB_URI is missing from environment variables.\n' +
      '     Set it in .env (local) or Render → Environment (production).'
    );
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGODB_URI, CONNECT_OPTIONS);
    // 'connected' event also fires, but we suppress it on first connect (see below)
    // so we log here instead — single, clean line.
    console.log(`[DB] Connected to MongoDB — database: "${mongoose.connection.name}"`);
  } catch (err) {
    console.error('[DB] Initial connection failed:', err.message);
    console.error('[DB] Common causes: wrong password, IP not whitelisted, cluster paused, typo in URI.');
    process.exit(1);
  }
};

// ── Graceful close (called by shutdown handler in airteltigo-server.js) ──
const closeDatabase = async () => {
  try {
    await mongoose.connection.close();
    console.log('✅ Database connection closed');
  } catch (err) {
    console.error('❌ Error closing database connection:', err.message);
    throw err;
  }
};

// ── Lifecycle events ──
// 'connected' fires on the initial connect AND on every reconnect after a drop.
// We only want to log it for reconnects (initial connect is logged in connectDB above).
let firstConnect = true;
mongoose.connection.on('connected', () => {
  if (firstConnect) { firstConnect = false; return; } // silence the startup duplicate
  console.log(`[DB] Reconnected to MongoDB — database: "${mongoose.connection.name}"`);
});

mongoose.connection.on('disconnected', () => {
  if (shuttingDown) {
    // Process is exiting intentionally — this is normal, don't alarm anyone.
    return;
  }
  // Transient drop — Mongoose reconnects automatically; just note it.
  console.warn('[DB] Disconnected from MongoDB — reconnecting automatically...');
});

mongoose.connection.on('error', (err) => {
  // Log but do NOT exit — the driver will keep retrying.
  console.error('[DB] Connection error (driver will retry):', err.message);
});

// 'close' only fires on an explicit mongoose.connection.close() call (our SIGINT/SIGTERM path).
mongoose.connection.on('close', () => {
  console.log('[DB] Connection closed.');
});

// ── Keep-alive ping ──
// Render's infrastructure can kill idle TCP sockets.
// Pinging every 30 s keeps the socket warm so it's never silently dropped.
setInterval(async () => {
  if (mongoose.connection.readyState !== 1) return; // 1 = connected
  try {
    await mongoose.connection.db.admin().ping();
  } catch (e) {
    // Non-fatal — the driver's own reconnect will kick in.
    console.warn('[DB] Keep-alive ping failed:', e.message);
  }
}, 30_000);

module.exports = { connectDB, closeDatabase, markShutdown };
