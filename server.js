'use strict';

const path = require('path');
const express = require('express');

const config = require('./src/config');
const { Store } = require('./src/store');
const { seedDefaults, login } = require('./src/auth');
const { ingestRouter } = require('./src/ingest');
const { apiRouter } = require('./src/api');
const { startPoller } = require('./src/poller');
const { createNotifier } = require('./src/notify');
const { createDb } = require('./src/db');
const { startDemo } = require('./src/demo');

const app = express();
const store = new Store();
const notifier = createNotifier();
store.setNotifier((alert) => notifier.dispatchForAlert(alert, store));

async function bootstrap() {
  if (config.DATABASE_URL) {
    try {
      const db = createDb(config.DATABASE_URL);
      await db.init();
      store.attachDb(db);
    } catch (e) {
      console.error('[db] init failed — continuing on in-memory + JSON:', e.message);
    }
  }
  await store.load();               // restore master data (DB preferred, else JSON)
  if (store.db) await store.backfillFromDb(config.BACKFILL_HOURS); // restore live + trends
  seedDefaults(store);              // ensure a super admin exists (before demo seeding)

  setInterval(() => store.sweepOffline(), 30000);
  setInterval(() => {
    for (const { alert, tier } of store.dueEscalations()) notifier.sendEscalation(alert, tier, store);
  }, (config.ESCALATION_INTERVAL || 60) * 1000);
  startPoller(store);
  if (config.DEMO_MODE) startDemo(store);
  require('./src/mqtt').startMqtt(store, config); // optional, only if MQTT_URL set

  // Data retention: daily purge of readings older than RETENTION_DAYS (if >0 and DB attached).
  if (config.RETENTION_DAYS > 0 && store.db) {
    const runPurge = () => store.db.purgeOld(config.RETENTION_DAYS)
      .then((n) => { if (n) console.log(`[retention] purged ${n} readings older than ${config.RETENTION_DAYS} days`); })
      .catch((e) => console.error('[retention]', e.message));
    runPurge();
    setInterval(runPurge, 24 * 3600 * 1000);
  }

  // Daily report email scheduler (checks each minute; fires once at the set hour).
  const jwt = require('jsonwebtoken');
  let lastReportDay = null;
  setInterval(() => {
    const cfg = (store.getAlertConfig().report) || {};
    if (!cfg.enabled || !cfg.emails || !cfg.emails.length) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === (cfg.hour != null ? cfg.hour : 7) && lastReportDay !== day) {
      lastReportDay = day;
      const base = cfg.base_url || config.REPORT_BASE_URL || '';
      // (a) configured control-room recipients (see everything)
      if (cfg.emails && cfg.emails.length) {
        const token = jwt.sign({ sub: 'report-link', role: 'railway_hq' }, config.JWT_SECRET, { expiresIn: '3d' });
        notifier.sendReportEmail(base, token, cfg.emails, store).catch((e) => console.error('[report]', e.message));
      }
      // (b) each user with an email gets a link scoped to THEIR assigned assets
      let sent = 0;
      for (const u of store.listUsers()) {
        const su = store.getUser(u.username);
        if (!su || !su.email) continue;
        const token = jwt.sign({ sub: u.username, role: u.role }, config.JWT_SECRET, { expiresIn: '3d' });
        notifier.sendReportEmail(base, token, [su.email], store).catch(() => {});
        sent++;
      }
      console.log(`[report] daily report dispatched (control-room + ${sent} user(s))`);
    }
  }, 60 * 1000);
}

app.use(express.json({ limit: '256kb' }));

// --- Security headers (production hardening) ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// --- Optional HTTPS enforcement (behind Railway's proxy). Opt-in via env. ---
if (process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => {
    if ((req.headers['x-forwarded-proto'] || '').split(',')[0] === 'http') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

// --- Lightweight in-memory rate limiter (no external dependency) ---
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n > v.reset) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').split(',')[0].trim();
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; hits.set(ip, rec); }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: 'Too many requests — please slow down.' });
    next();
  };
}
// Brute-force protection on login; generous global cap that never hits normal
// dashboard polling or per-RUT hardware posting (each RUT is a distinct IP).
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40 });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 600 });

// Clean JSON error for malformed request bodies (e.g. a garbled hardware POST)
// instead of crashing or returning an HTML error page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  if (err) return res.status(400).json({ ok: false, error: 'Bad request' });
  next();
});

app.post('/api/v1/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const result = login(store, username || '', password || '');
  if (!result) return res.status(401).json({ error: 'Invalid credentials' });
  res.json(result);
});

app.use('/api/v1', ingestRouter(store));                 // hardware ingest + device-config (not rate-limited)
app.use('/api/v1', apiLimiter, apiRouter(store, notifier)); // dashboard API (rate-limited)

app.get('/healthz', (req, res) => res.json({ ok: true, demo: config.DEMO_MODE }));
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));

// Unknown API paths get a JSON 404, not the SPA HTML.
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API endpoint' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => {
  console.log(`[server] ${sig} received, flushing state...`);
  store.flushSync();
  process.exit(0);
}));

// Keep the service alive if a stray async error occurs (e.g. odd hardware data
// or a failed outbound SMS/email). Log it rather than crashing the demo.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));

// Warn loudly if production is running with default secrets.
function securityChecks() {
  const prod = process.env.NODE_ENV === 'production';
  if (prod && config.JWT_SECRET === 'himnish-raip-d3-dev-secret-change-me') {
    console.warn('[SECURITY] JWT_SECRET is still the default — set a strong JWT_SECRET env var!');
  }
  if (prod && config.DATA_API_KEY === 'himnish_emu_key_2025') {
    console.warn('[SECURITY] DATA_API_KEY is still the default — set your own DATA_API_KEY!');
  }
  if (config.DEMO_MODE) console.warn('[NOTICE] DEMO_MODE is ON — synthetic data is being generated. Set DEMO_MODE=false for live hardware.');
}
securityChecks();

bootstrap().then(() => {
  app.listen(config.PORT, () => {
    const t = store.getThresholds();
    console.log(`EMU Motor Coach TM Monitoring on :${config.PORT}`);
    console.log(`DEMO_MODE=${config.DEMO_MODE}  DATA_DIR=${config.DATA_DIR}  DB=${store.db ? 'PostgreSQL' : 'JSON+memory'}`);
    console.log(`thresholds: warn>${t.CFG_WARN_TEMP} high>${t.CFG_HIGH_TEMP} crit>${t.CFG_CRIT_TEMP}`);
  });
}).catch((e) => { console.error('[server] bootstrap error:', e); process.exit(1); });
