'use strict';
// Everything a signed-in person can do to their own account, and what a super admin can do to others.
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const pw = require('./password');
const totp = require('./totp');

const iso = () => new Date().toISOString();

function accountRouter(store) {
  const r = express.Router();
  const ADMIN = auth.requireRole(...config.ADMIN_ROLES);
  const me = (req) => store.getUser(req.user.sub);
  const fail = (res, code, msg, extra) => res.status(code).json(Object.assign({ error: msg }, extra || {}));

  // ---------------------------------------------------------------- self service
  r.get('/me', (req, res) => {
    const u = me(req); if (!u) return fail(res, 401, 'Session ended.');
    res.json(auth.publicUser(u, { last_login: u.last_login || null, last_login_ip: u.last_login_ip || null, pw_changed_at: u.pw_changed_at || null,
      recovery_codes_left: u.totp && u.totp.enabled ? (u.totp.recovery || []).length : 0 }));
  });

  r.post('/logout', (req, res) => { auth.revokeCurrent(req); auth.sec('logout', req.user.sub, req); res.json({ ok: true }); });

  r.post('/me/logout-all', (req, res) => {
    const u = me(req); auth.revokeAll(u);
    store.logAudit({ user: u.username, action: 'logout_everywhere', detail: '' }); auth.sec('logout_all', u.username, req);
    store._persist(); res.json({ ok: true });
  });

  r.post('/me/password', async (req, res) => {
    const u = me(req); const { current, next } = req.body || {};
    if (!current || !next) return fail(res, 400, 'Current and new password are required.');
    const chk = await auth.verifyOwnPassword(store, u, current, req);
    if (!chk.ok) return chk.locked ? fail(res, 423, `Too many wrong attempts. Try again in ${chk.locked} minute(s).`) : fail(res, 400, 'Current password is wrong.');
    const bad = pw.policyError(next, u.username); if (bad) return fail(res, 400, bad);
    if (await pw.verify(next, u.hash)) return fail(res, 400, 'The new password must be different from the current one.');
    u.hash = await pw.hash(next); u.must_change = false; u.pw_changed_at = iso();
    auth.revokeAll(u);                                   // every other device / stolen session is signed out
    store.logAudit({ user: u.username, action: 'password_changed', detail: '' }); auth.sec('password_changed', u.username, req);
    store._persist();
    res.json({ ok: true, token: auth.reissue(u), user: auth.publicUser(u) });
  });

  // ---------------------------------------------------------------- two-factor (authenticator app)
  r.post('/me/2fa/setup', (req, res) => {
    const u = me(req);
    if (u.totp && u.totp.enabled) return fail(res, 400, 'Two-factor authentication is already on. Turn it off first to set up a new phone.');
    const secret = totp.generateSecret();
    u.totp_pending = { secret, at: iso() }; store._persist();
    res.json({ secret, otpauth_uri: totp.otpauthUri({ issuer: auth.ISSUER, account: u.username, secret }), issuer: auth.ISSUER, account: u.username });
  });

  r.post('/me/2fa/enable', (req, res) => {
    const u = me(req); const p = u.totp_pending;
    if (!p || Date.now() - Date.parse(p.at) > 15 * 60000) return fail(res, 400, 'Setup expired. Start the 2FA setup again.');
    const step = totp.verify(p.secret, (req.body || {}).code, { lastStep: 0 });
    if (!step) return fail(res, 400, 'That code is not correct. Check the phone time and try the next code.');
    const rc = totp.newRecoveryCodes(8);
    u.totp = { enabled: true, secret: p.secret, last_step: step, recovery: rc.hashed, enabled_at: iso() }; delete u.totp_pending;
    auth.revokeAll(u);                                   // other devices sign in again with the new second step
    store.logAudit({ user: u.username, action: '2fa_enabled', detail: '' }); auth.sec('2fa_enabled', u.username, req);
    store._persist();
    res.json({ ok: true, recovery_codes: rc.plain, token: auth.reissue(u), user: auth.publicUser(u) });
  });

  r.post('/me/2fa/disable', async (req, res) => {
    const u = me(req); const { password, code } = req.body || {};
    if (!(u.totp && u.totp.enabled)) return fail(res, 400, 'Two-factor authentication is not on.');
    if (auth.REQUIRE_2FA_ROLES.includes(u.role)) return fail(res, 403, 'Your role must keep two-factor authentication on.');
    const chk = await auth.verifyOwnPassword(store, u, password, req);
    if (!chk.ok) return chk.locked ? fail(res, 423, `Too many wrong attempts. Try again in ${chk.locked} minute(s).`) : fail(res, 400, 'Password is wrong.');
    if (!totp.verify(u.totp.secret, code, { lastStep: u.totp.last_step || 0 })) return fail(res, 400, 'The 6-digit code is not correct.');
    delete u.totp; auth.revokeAll(u);
    store.logAudit({ user: u.username, action: '2fa_disabled', detail: '' }); auth.sec('2fa_disabled', u.username, req);
    store._persist();
    res.json({ ok: true, token: auth.reissue(u), user: auth.publicUser(u) });
  });

  // ---------------------------------------------------------------- super admin: manage other people
  const target = (req, res) => { const u = store.getUser(req.params.username); if (!u) { fail(res, 404, 'user not found'); return null; } return u; };
  const activeAdmins = () => [...store.users.values()].filter((x) => x.role === 'super_admin' && !x.disabled).length;

  r.post('/users/:username/reset-password', ADMIN, async (req, res) => {
    const u = target(req, res); if (!u) return;
    if (u.username === req.user.sub) return fail(res, 400, 'Use "Change password" (person icon) for your own account.');
    const temp = pw.randomPassword();
    u.hash = await pw.hash(temp); u.must_change = true; u.pw_changed_at = iso(); auth.revokeAll(u); auth.unlock(u.username);
    store.logAudit({ user: req.user.sub, action: 'reset_password', detail: u.username }); auth.sec('password_reset', u.username, req, 'by ' + req.user.sub);
    store._persist();
    res.json({ ok: true, temp_password: temp, note: 'Shown only once. The user must choose a new password at the first sign-in.' });
  });
  r.post('/users/:username/unlock', ADMIN, (req, res) => {
    const u = target(req, res); if (!u) return;
    auth.unlock(u.username); store.logAudit({ user: req.user.sub, action: 'unlock_user', detail: u.username }); auth.sec('account_unlocked', u.username, req, 'by ' + req.user.sub);
    res.json({ ok: true });
  });
  r.post('/users/:username/disable', ADMIN, (req, res) => {
    const u = target(req, res); if (!u) return;
    if (u.username === req.user.sub) return fail(res, 400, 'You cannot disable your own account.');
    if (u.role === 'super_admin' && !u.disabled && activeAdmins() < 2) return fail(res, 400, 'Cannot disable the last active super admin.');
    u.disabled = true; auth.revokeAll(u);
    store.logAudit({ user: req.user.sub, action: 'disable_user', detail: u.username }); auth.sec('account_disabled', u.username, req, 'by ' + req.user.sub);
    store._persist(); res.json({ ok: true });
  });
  r.post('/users/:username/enable', ADMIN, (req, res) => {
    const u = target(req, res); if (!u) return;
    u.disabled = false; auth.unlock(u.username);
    store.logAudit({ user: req.user.sub, action: 'enable_user', detail: u.username }); auth.sec('account_enabled', u.username, req, 'by ' + req.user.sub);
    store._persist(); res.json({ ok: true });
  });
  r.post('/users/:username/logout', ADMIN, (req, res) => {
    const u = target(req, res); if (!u) return;
    if (u.username === req.user.sub) return fail(res, 400, 'Use "Sign out" (person icon) for your own account.');
    auth.revokeAll(u); store.logAudit({ user: req.user.sub, action: 'force_logout', detail: u.username }); auth.sec('forced_logout', u.username, req, 'by ' + req.user.sub);
    store._persist(); res.json({ ok: true });
  });
  r.post('/users/:username/2fa-reset', ADMIN, (req, res) => {
    const u = target(req, res); if (!u) return;
    if (u.username === req.user.sub) return fail(res, 400, 'Use "Turn off 2-step" (person icon) for your own account.');
    delete u.totp; delete u.totp_pending; auth.revokeAll(u);
    store.logAudit({ user: req.user.sub, action: '2fa_reset', detail: u.username }); auth.sec('2fa_reset', u.username, req, 'by ' + req.user.sub);
    store._persist(); res.json({ ok: true });
  });

  r.get('/security/events', ADMIN, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const type = req.query.type ? String(req.query.type) : null;
    res.json(store.secLog.filter((e) => !type || e.type === type).slice(0, limit));
  });

  return r;
}

module.exports = { accountRouter };
