'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const pw = require('./password');
const totp = require('./totp');

let STORE = null;
const setStore = (s) => { STORE = s; };

// ---------------------------------------------------------------------------
// Tunables (all can be overridden in .env)
// ---------------------------------------------------------------------------
const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS) || 5;                 // wrong passwords before an account locks
const LOCK_BASE_MIN = Number(process.env.LOGIN_LOCK_MINUTES) || 15;         // 1st lock; doubles each repeat (max 24 h)
const IP_MAX_FAILS = Number(process.env.LOGIN_IP_MAX_FAILS) || 30;          // failed attempts per IP per 15 min
const MFA_TTL = '5m';
const REQUIRE_2FA_ROLES = String(process.env.REQUIRE_2FA_ROLES || '').split(',').map((x) => x.trim()).filter(Boolean);
const ISSUER = 'HIMNISH EMU';

const attempts = new Map();   // "username" -> { fails, first, lockUntil, strikes }   (also tracks unknown names, so a lock never reveals who exists)
const ipFails = new Map();    // ip -> { count, reset }
const revoked = new Map();    // jti -> exp (seconds)   (signed-out sessions)
// Password checks run in the libuv thread pool. Let 4 run at once and QUEUE the rest (a depot signing in together
// just waits a moment); this keeps threads free for database and DNS work so RUT data keeps flowing.
const SLOTS = Number(process.env.LOGIN_PARALLEL) || 4, MAX_QUEUE = 400;
let running = 0; const waiters = [];
async function withSlot(fn) {
  if (waiters.length >= MAX_QUEUE) { const e = new Error('busy'); e.busy = true; throw e; }
  if (running >= SLOTS) await new Promise((res) => waiters.push(res));
  running++;
  try { return await fn(); } finally { running--; const w = waiters.shift(); if (w) w(); }
}

setInterval(() => {
  const n = Date.now(), s = Math.floor(n / 1000);
  for (const [k, v] of attempts) if (!v.lockUntil && n - v.first > 3600e3) attempts.delete(k); else if (v.lockUntil && n > v.lockUntil && n - v.lockUntil > 24 * 3600e3) attempts.delete(k);
  for (const [k, v] of ipFails) if (n > v.reset) ipFails.delete(k);
  for (const [k, exp] of revoked) if (exp < s) revoked.delete(k);
}, 60000).unref();

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  return (xff ? xff.split(',').pop().trim() : '') || req.socket.remoteAddress || 'x';
}
const keyOf = (username) => String(username || '').trim().toLowerCase().slice(0, 64);
const nowMs = () => Date.now();
const mins = (ms) => Math.max(1, Math.ceil(ms / 60000));

function sec(type, username, req, detail) {
  if (STORE && STORE.logSecurity) STORE.logSecurity({ type, user: username || '', ip: req ? clientIp(req) : '', ua: req ? String(req.headers['user-agent'] || '').slice(0, 120) : '', detail: detail || '' });
}

// --------------------------------------------------------------------- first-run admin
async function seedDefaults(store) {
  STORE = store;
  const initial = process.env.ADMIN_INITIAL_PASSWORD;
  if (!store.getUser('admin')) {
    if (initial && !pw.policyError(initial, 'admin')) {
      store.seedUser({ username: 'admin', password: initial, role: 'super_admin' });
      console.log('[auth] super admin "admin" created with the password from ADMIN_INITIAL_PASSWORD (remove that line from .env now)');
    } else {
      store.seedUser({ username: 'admin', password: 'himnish@2025', role: 'super_admin', must_change: !config.DEMO_MODE });
      console.log('[auth] seeded super admin: admin / himnish@2025  -> must be changed at first sign-in');
    }
  }
  // An existing install that still uses the public default password is forced to change it at the next sign-in.
  if (!config.DEMO_MODE) {
    for (const u of store.users.values()) {
      if (!u.must_change && await pw.verify('himnish@2025', u.hash)) { u.must_change = true; store._persist(); console.log(`[auth] user "${u.username}" still has the default password -> change forced at next sign-in`); }
    }
  }
}

// --------------------------------------------------------------------- lockout bookkeeping
function lockRemaining(key) { const a = attempts.get(key); return a && a.lockUntil && a.lockUntil > nowMs() ? a.lockUntil - nowMs() : 0; }
function registerFailure(key, ip, username, req, why) {
  const n = nowMs();
  let a = attempts.get(key);
  if (!a || (!a.lockUntil && n - a.first > 15 * 60000)) a = { fails: 0, first: n, lockUntil: 0, strikes: a ? a.strikes : 0 };
  a.fails++; attempts.set(key, a);
  let f = ipFails.get(ip); if (!f || n > f.reset) f = { count: 0, reset: n + 15 * 60000 }; f.count++; ipFails.set(ip, f);
  sec('login_failed', username, req, why || 'wrong password');
  if (a.fails >= MAX_FAILS) {
    a.strikes++; a.lockUntil = n + Math.min(LOCK_BASE_MIN * 2 ** (a.strikes - 1), 24 * 60) * 60000; a.fails = 0;
    sec('account_locked', username, req, `locked for ${mins(a.lockUntil - n)} min`);
    if (STORE) STORE.logAudit({ user: username, action: 'account_locked', detail: `after ${MAX_FAILS} wrong attempts from ${ip}` });
  }
}
const clearFailures = (key) => attempts.delete(key);

// Express gate: refuses an IP that produced too many FAILED sign-ins. Successful sign-ins never count,
// so a whole office behind one public IP can still log in every morning.
function loginGate(req, res, next) {
  const f = ipFails.get(clientIp(req));
  if (f && Date.now() <= f.reset && f.count >= IP_MAX_FAILS) return res.status(429).json({ error: 'Too many failed sign-in attempts from this network. Try again in a few minutes.' });
  next();
}

// --------------------------------------------------------------------- tokens
const needs2faSetup = (u) => REQUIRE_2FA_ROLES.includes(u.role) && !(u.totp && u.totp.enabled);
function publicUser(u, extra) {
  return Object.assign({ username: u.username, role: u.role, depot_id: u.depot_id, must_change: !!u.must_change,
    totp_enabled: !!(u.totp && u.totp.enabled), must_setup_2fa: needs2faSetup(u) }, extra || {});
}

function issueSession(store, u, req) {
  const jti = crypto.randomBytes(12).toString('hex');
  const token = jwt.sign({ sub: u.username, v: 2, tv: u.token_version || 0, jti }, config.JWT_SECRET, { expiresIn: config.JWT_TTL });
  const prev = { last_login: u.last_login || null, last_login_ip: u.last_login_ip || null };
  u.last_login = new Date().toISOString(); u.last_login_ip = req ? clientIp(req) : null;
  sec('login', u.username, req, u.totp && u.totp.enabled ? 'with 2FA' : '');
  store._persistSlow();
  return { token, user: publicUser(u, prev) };
}

// --------------------------------------------------------------------- step 1: username + password
async function login(store, username, password, req) {
  STORE = store;
  const key = keyOf(username);
  const ip = req ? clientIp(req) : 'x';
  if (!key || typeof password !== 'string' || !password || password.length > 256) return { status: 401, body: { error: 'Invalid username or password.' } };
  const left = lockRemaining(key);
  if (left) return { status: 423, body: { error: `Too many wrong attempts. This account is locked for ${mins(left)} more minute(s).`, retry_after_min: mins(left) } };
  let ok = false; const u = store.getUser(String(username).trim());
  try { ok = await withSlot(() => (u ? pw.verify(password, u.hash) : pw.verifyDummy(password))); }
  catch (e) { if (e.busy) return { status: 503, body: { error: 'Server is busy signing people in. Try again in a few seconds.' } }; throw e; }
  if (!ok) {
    registerFailure(key, ip, String(username).slice(0, 64), req, u ? 'wrong password' : 'unknown user');
    const l2 = lockRemaining(key);
    if (l2) return { status: 423, body: { error: `Too many wrong attempts. This account is locked for ${mins(l2)} minute(s).`, retry_after_min: mins(l2) } };
    return { status: 401, body: { error: 'Invalid username or password.' } };
  }
  if (u.disabled) { sec('login_refused', u.username, req, 'account disabled'); return { status: 403, body: { error: 'This account is disabled. Please contact the administrator.' } }; }
  clearFailures(key);
  if (pw.needsUpgrade(u.hash)) pw.hash(password).then((h) => { u.hash = h; store._persist(); }).catch(() => {});
  if (u.totp && u.totp.enabled) {
    const mfa_token = jwt.sign({ sub: u.username, scope: 'mfa', tv: u.token_version || 0 }, config.JWT_SECRET, { expiresIn: MFA_TTL });
    return { status: 200, body: { mfa_required: true, mfa_token } };
  }
  return { status: 200, body: issueSession(store, u, req) };
}

// --------------------------------------------------------------------- step 2: authenticator code or recovery code
async function loginMfa(store, mfaToken, code, req) {
  STORE = store;
  let p; try { p = jwt.verify(String(mfaToken || ''), config.JWT_SECRET); } catch (e) { return { status: 401, body: { error: 'The sign-in step expired. Please start again.' } }; }
  if (p.scope !== 'mfa') return { status: 401, body: { error: 'Invalid sign-in step.' } };
  const u = store.getUser(p.sub);
  if (!u || u.disabled || (p.tv || 0) !== (u.token_version || 0) || !(u.totp && u.totp.enabled)) return { status: 401, body: { error: 'Please sign in again.' } };
  const key = 'mfa:' + keyOf(u.username);
  const left = lockRemaining(key);
  if (left) return { status: 423, body: { error: `Too many wrong codes. Try again in ${mins(left)} minute(s).`, retry_after_min: mins(left) } };
  const c = String(code || '').trim();
  let good = false;
  if (/^\d{3}\s?\d{3}$/.test(c)) {
    const step = totp.verify(u.totp.secret, c, { lastStep: u.totp.last_step || 0 });
    if (step) { u.totp.last_step = step; good = true; }
  } else if (c.length >= 8) {
    const rest = totp.useRecoveryCode(u.totp.recovery || [], c);
    if (rest) { u.totp.recovery = rest; good = true; sec('recovery_code_used', u.username, req, `${rest.length} left`); store.logAudit({ user: u.username, action: 'recovery_code_used', detail: `${rest.length} left` }); store._persist(); }
  }
  if (!good) { registerFailure(key, clientIp(req), u.username, req, 'wrong 2FA code'); const l2 = lockRemaining(key); return { status: l2 ? 423 : 401, body: { error: l2 ? `Too many wrong codes. Try again in ${mins(l2)} minute(s).` : 'Wrong code. Check the time on your phone and try again.' } }; }
  clearFailures(key);
  return { status: 200, body: issueSession(store, u, req) };
}

// --------------------------------------------------------------------- per-request check
const OPEN_WHEN_MUST_CHANGE = ['/me', '/me/password', '/logout'];
const OPEN_WHEN_MUST_2FA = ['/me', '/me/2fa/setup', '/me/2fa/enable', '/logout'];

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : null;
  // Emailed report links carry a signed ?token= (only accepted on report paths).
  if (!token && req.query && req.query.token && req.path.indexOf('/report/') >= 0) token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  let p;
  try { p = jwt.verify(token, config.JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

  if (p.scope === 'mfa') return res.status(401).json({ error: 'Finish the sign-in first.' });
  if (p.scope === 'report') {
    // Limited-scope emailed link: valid for /report/ paths only, and only while the user (if any) still exists.
    if (req.path.indexOf('/report/') < 0) return res.status(403).json({ error: 'Report link token cannot be used for this endpoint' });
    if (p.sub === 'report-link') { req.user = { sub: 'report-link', role: 'railway_hq', scope: 'report' }; return next(); }
    const ru = STORE && STORE.getUser(p.sub);
    if (!ru || ru.disabled) return res.status(401).json({ error: 'Account no longer active' });
    req.user = { sub: ru.username, role: ru.role, depot_id: ru.depot_id, scope: 'report' }; return next();
  }
  if (p.v !== 2) return res.status(401).json({ error: 'Please sign in again.' });        // tokens from before this security upgrade
  const u = STORE && STORE.getUser(p.sub);
  // Role, depot and existence are read from the store on EVERY call: a deleted, disabled or demoted user loses access at once.
  if (!u || u.disabled) return res.status(401).json({ error: 'Session ended. Please sign in again.' });
  if ((p.tv || 0) !== (u.token_version || 0) || revoked.has(p.jti)) return res.status(401).json({ error: 'Session ended. Please sign in again.' });
  if (u.must_change && !OPEN_WHEN_MUST_CHANGE.includes(req.path)) return res.status(403).json({ error: 'You must set a new password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
  if (needs2faSetup(u) && !u.must_change && !OPEN_WHEN_MUST_2FA.includes(req.path)) return res.status(403).json({ error: 'Two-factor authentication must be set up before continuing.', code: 'TWO_FACTOR_SETUP_REQUIRED' });
  req.user = { sub: u.username, role: u.role, depot_id: u.depot_id, jti: p.jti, exp: p.exp };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient role for this action' });
    next();
  };
}

// Re-check the CURRENT password before a sensitive change (password change, disabling 2FA). Wrong tries count toward a lock.
async function verifyOwnPassword(store, u, password, req) {
  const key = 'pwc:' + keyOf(u.username);
  const left = lockRemaining(key);
  if (left) return { ok: false, locked: mins(left) };
  const ok = await withSlot(() => pw.verify(String(password || ''), u.hash));
  if (!ok) { registerFailure(key, clientIp(req), u.username, req, 'wrong current password'); const l2 = lockRemaining(key); return { ok: false, locked: l2 ? mins(l2) : 0 }; }
  clearFailures(key);
  return { ok: true };
}
// new token for the SAME person after their session list was reset (password change, 2FA change)
function reissue(u) {
  const jti = crypto.randomBytes(12).toString('hex');
  return jwt.sign({ sub: u.username, v: 2, tv: u.token_version || 0, jti }, config.JWT_SECRET, { expiresIn: config.JWT_TTL });
}

// sign this session out on the server (the token can no longer be used, even if someone copied it)
function revokeCurrent(req) { if (req.user && req.user.jti) revoked.set(req.user.jti, req.user.exp || Math.floor(Date.now() / 1000) + 86400); }
// sign the user out on EVERY device
function revokeAll(u) { u.token_version = (u.token_version || 0) + 1; }
const unlock = (username) => { attempts.delete(keyOf(username)); attempts.delete('mfa:' + keyOf(username)); };
const lockInfo = (username) => Math.max(lockRemaining(keyOf(username)), lockRemaining('mfa:' + keyOf(username)));

module.exports = { setStore, seedDefaults, login, loginMfa, loginGate, requireAuth, requireRole, revokeCurrent, revokeAll, unlock, lockInfo,
  verifyOwnPassword, reissue,
  publicUser, needs2faSetup, clientIp, ISSUER, REQUIRE_2FA_ROLES, sec };
