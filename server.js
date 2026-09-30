'use strict';
// More worker threads for password hashing / file / DNS work (must be set before the first use of the pool).
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';
require('dotenv').config(); // load .env (DATABASE_URL, JWT_SECRET, SMTP, SMS ...) before config.js reads process.env

const path = require('path');
const express = require('express');
const compression = require('compression');

const config = require('./src/config');
const { Store } = require('./src/store');
const auth = require('./src/auth');
const { seedDefaults, login, loginMfa, loginGate } = auth;
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

// Refuses to start with a configuration that would be unsafe in production. JWT_SECRET is checked
// unconditionally (a weak/default one lets anyone forge a super_admin session — there is no safe
// fallback for that). DATA_API_KEY/BOOTSTRAP_KEY are checked only when STRICT_SECURITY=true, because
// an existing fleet of field devices may still be using the shared defaults; turn STRICT_SECURITY on
// once every device has its own per-device key (Admin -> Field Devices) so the shared defaults are
// refused outright instead of just warned about.
function validateConfig() {
  const problems = [];
  const weakSecret = !config.JWT_SECRET || config.JWT_SECRET.length < 32 || config.JWT_SECRET === 'himnish-raip-d3-dev-secret-change-me';
  if (weakSecret && !config.DEMO_MODE) problems.push('JWT_SECRET is missing, too short (<32 chars) or the built-in default. Set: openssl rand -hex 32');
  if (config.STRICT_SECURITY) {
    if (config.DATA_API_KEY === 'himnish_emu_key_2025') problems.push('STRICT_SECURITY is on but DATA_API_KEY is still the public default.');
    if (config.BOOTSTRAP_KEY === 'himnish_bootstrap_2025') problems.push('STRICT_SECURITY is on but BOOTSTRAP_KEY is still the public default.');
  }
  if (!config.DEMO_MODE && !config.DATABASE_URL) problems.push('DEMO_MODE is off but DATABASE_URL is not set — readings will only be kept in a local JSON file, not a real database.');
  if (problems.length) {
    console.error('\n[FATAL] Refusing to start — fix these in .env:');
    problems.forEach((p) => console.error('  - ' + p));
    console.error('(DEMO_MODE=true skips the JWT_SECRET/DATABASE_URL checks, for local testing only.)\n');
    process.exit(1);
  }
}

async function bootstrap() {
  validateConfig();
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
  await seedDefaults(store);        // ensure a super admin exists (before demo seeding); flags accounts still on the default password

  // Guards EVERY scheduled timer in this file against a runaway loop: if the computed period is
  // missing, zero, negative or NaN (a config value absent after a partial deploy, a bad .env, or any
  // future typo), setInterval(fn, NaN) fires the callback almost continuously in Node — which is
  // exactly what took the server to 100% CPU and wrote 19,000+ backup files in minutes on 30 Sep 2026.
  // A period below MIN_MS is clamped up to it instead of silently accepted, and the problem is logged
  // loudly so it is never silent again.
  function safeInterval(label, fn, ms, minMs) {
    const min = minMs || 10000;
    const safe = Number.isFinite(ms) && ms >= min ? ms : min;
    if (safe !== ms) console.error(`[SECURITY] scheduler "${label}": computed interval was ${ms} (invalid) — using ${safe} ms instead. Check the related config value.`);
    return setInterval(fn, safe);
  }

  setInterval(() => store.sweepOffline(), 30000);
  safeInterval('escalation-check', () => {
    for (const { alert, tier } of store.dueEscalations()) notifier.sendEscalation(alert, tier, store);
  }, (config.ESCALATION_INTERVAL || 60) * 1000, 5000);
  // Offline alerts never re-raise while the outage continues (one incident = one active alert row,
  // see store.js _raise), so nothing else would ever re-notify for a coach that stays offline for
  // hours. Check every 5 minutes and re-dispatch email for each still-active offline alert; the
  // emailSend throttle inside dispatchForAlert (EMAIL_REPEAT_MIN, default 60) is what actually turns
  // that into "one email now, the next one only after an hour if it is still offline" — SMS is
  // hard-blocked for this severity in notify.js regardless of what the rule's channels say.
  setInterval(() => {
    for (const alert of store.activeOfflineAlerts()) notifier.dispatchForAlert(alert, store).catch(() => {});
  }, 5 * 60000);
  // Automatic backups: first one 2 minutes after boot (so it never competes with startup), then
  // every BACKUP_INTERVAL_HOURS. Disabled entirely in DEMO_MODE (nothing worth backing up there).
  if (!config.DEMO_MODE) {
    setTimeout(() => store.autoBackup(), 2 * 60000);
    safeInterval('auto-backup', () => store.autoBackup(), config.BACKUP_INTERVAL_HOURS * 3600000, 3600000);
  }
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
        const token = jwt.sign({ sub: 'report-link', role: 'railway_hq', scope: 'report' }, config.JWT_SECRET, { expiresIn: '3d' });
        notifier.sendReportEmail(base, token, cfg.emails, store).catch((e) => console.error('[report]', e.message));
      }
      // (b) each user with an email gets a link scoped to THEIR assigned assets
      let sent = 0;
      for (const u of store.listUsers()) {
        const su = store.getUser(u.username);
        if (!su || !su.email) continue;
        const token = jwt.sign({ sub: u.username, role: u.role, scope: 'report' }, config.JWT_SECRET, { expiresIn: '3d' });
        notifier.sendReportEmail(base, token, [su.email], store).catch(() => {});
        sent++;
      }
      console.log(`[report] daily report dispatched (control-room + ${sent} user(s))`);
    }
  }, 60 * 1000);
}

// gzip JSON/HTML/JS: the fleet view is ~1.8 MB of JSON at 2000 coaches (about 12x smaller compressed).
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '256kb' }));

// --- Security headers (production hardening) ---
// Content-Security-Policy: the page's own inline <script> is allowed by its SHA-256 hash (recomputed whenever the file
// changes), so injected script from anywhere else cannot run even if some text were ever not escaped.
const crypto = require('crypto');
const fs = require('fs');
const cspState = { key: '', value: '' };
function inlineScriptHashes(file) {
  try {
    const html = fs.readFileSync(file, 'utf8'); const out = [];
    html.replace(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi, (m, body) => { if (body.trim()) out.push("'sha256-" + crypto.createHash('sha256').update(body, 'utf8').digest('base64') + "'"); return m; });
    return out;
  } catch (e) { return []; }
}
function cspHeader() {
  const files = ['index.html', 'docs.html'].map((f) => path.join(__dirname, 'public', f));
  const key = files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } }).join('|');
  if (key !== cspState.key) {
    const hashes = [].concat(...files.map(inlineScriptHashes)).join(' ');
    cspState.key = key;
    cspState.value = ["default-src 'self'", `script-src 'self' ${hashes} https://cdnjs.cloudflare.com`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com", "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://cdnjs.cloudflare.com",
      "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
  }
  return cspState.value;
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', cspHeader());
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');   // never keep account or fleet data in a shared PC's cache
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
    // Use the RIGHT-most X-Forwarded-For entry (the one our own reverse proxy appended); the left-most is client-controlled and spoofable.
    const xff = String(req.headers['x-forwarded-for'] || '');
    const ip = (xff ? xff.split(',').pop().trim() : '') || req.socket.remoteAddress || 'x';
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
// Per office IP. A control room with many people behind ONE public IP (NAT) shares this budget; each open
// dashboard tab makes roughly 30-60 calls/min. Set API_RATE_MAX in .env to change it.
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: Number(process.env.API_RATE_MAX) || 3000 });

// Clean JSON error for malformed request bodies (e.g. a garbled hardware POST)
// instead of crashing or returning an HTML error page.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }
  if (err) return res.status(400).json({ ok: false, error: 'Bad request' });
  next();
});

// Sign-in. Only FAILED attempts count against an address (loginGate) and against an account (lockout in auth.js),
// so a whole office behind one public IP can sign in every morning, while guessing is stopped.
app.post('/api/v1/login', loginGate, async (req, res) => {
  const { username, password } = req.body || {};
  try { const r = await login(store, username, password, req); res.status(r.status).json(r.body); }
  catch (e) { console.error('[auth] login error:', e.message); res.status(500).json({ error: 'Sign-in failed. Please try again.' }); }
});
app.post('/api/v1/login/mfa', loginGate, async (req, res) => {
  const { mfa_token, code } = req.body || {};
  try { const r = await loginMfa(store, mfa_token, code, req); res.status(r.status).json(r.body); }
  catch (e) { console.error('[auth] mfa error:', e.message); res.status(500).json({ error: 'Sign-in failed. Please try again.' }); }
});

// --- Field-device relay (opt-in via RELAY_TARGET env var) ------------------
// Purpose: some RUT200 field devices are still hardcoded to this app's old
// URL and cannot be reached to update their BASE without a site visit. When
// RELAY_TARGET is set, this app transparently forwards ONLY the two hardware
// endpoints those devices call (device-config pull + reading ingest) to the
// new backend, so the RUT never needs to change. Everything else (dashboard,
// login, admin API) keeps running against THIS app's own store, untouched.
// This block is a no-op unless RELAY_TARGET is explicitly set in the
// environment — the AWS deployment never sets it, so it never activates there.
if (config.RELAY_TARGET) {
  const relayBase = config.RELAY_TARGET.replace(/\/+$/, '');
  console.log(`[relay] field-device traffic (/api/v1/device-config, /api/v1/ingest) -> ${relayBase}`);
  app.use(['/api/v1/device-config', '/api/v1/ingest'], async (req, res) => {
    try {
      const target = relayBase + req.originalUrl;
      const upstream = await fetch(target, {
        method: req.method,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': req.headers['x-api-key'] || '' },
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : JSON.stringify(req.body || {}),
      });
      const text = await upstream.text();
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      res.send(text);
    } catch (e) {
      console.error('[relay] forward failed:', e.message);
      res.status(502).json({ ok: false, error: 'relay upstream unreachable' });
    }
  });
}

app.use('/api/v1', ingestRouter(store));                 // hardware ingest + device-config (not rate-limited)
app.use('/api/v1', apiLimiter, apiRouter(store, notifier)); // dashboard API (rate-limited)

app.get('/healthz', (req, res) => res.json({ ok: true, demo: config.DEMO_MODE }));

// API docs (Swagger UI + openapi.json) reveal the full endpoint surface, so they are hidden unless
// DOCS_USER/DOCS_PASSWORD are set in .env, and then gated with HTTP Basic Auth (a browser-navigable
// page can't send a Bearer token, so the dashboard's own login can't protect it).
function requireDocsAuth(req, res, next) {
  if (!config.DOCS_USER || !config.DOCS_PASSWORD) return res.status(404).end();
  const h = req.headers.authorization || '';
  const [user, pass] = h.startsWith('Basic ') ? Buffer.from(h.slice(6), 'base64').toString().split(':') : [];
  const safeEq = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
    return A.length === B.length && crypto.timingSafeEqual(A, B); };
  const ok = safeEq(user, config.DOCS_USER) && safeEq(pass, config.DOCS_PASSWORD);
  if (!ok) { res.setHeader('WWW-Authenticate', 'Basic realm="EMU API docs"'); return res.status(401).end('Authentication required'); }
  next();
}
app.get('/docs', requireDocsAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'docs.html')));
app.get('/openapi.json', requireDocsAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'openapi.json')));

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
  if (config.JWT_SECRET === 'himnish-raip-d3-dev-secret-change-me') {
    console.warn('[SECURITY] JWT_SECRET is still the default — set a strong JWT_SECRET env var!');
  }
  if (config.DATA_API_KEY === 'himnish_emu_key_2025') {
    console.warn('[SECURITY] DATA_API_KEY is still the default — set your own DATA_API_KEY!');
  }
  if (config.BOOTSTRAP_KEY === 'himnish_bootstrap_2025') {
    console.warn('[SECURITY] BOOTSTRAP_KEY is still the default — rotate it (RUT scripts need the new key).');
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
