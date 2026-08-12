'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');

// Users now live in the persistent store. On first run (empty store) we seed a
// super admin; demo users/assets are seeded separately only in DEMO_MODE.
function seedDefaults(store) {
  if (!store.getUser('admin')) {
    store.seedUser({ username: 'admin', password: 'himnish@2025', role: 'super_admin' });
    console.log('[auth] seeded super admin: admin / himnish@2025  (CHANGE THIS)');
  }
}

function login(store, username, password) {
  const u = store.getUser(username);
  if (!u || !bcrypt.compareSync(password, u.hash)) return null;
  const token = jwt.sign({ sub: u.username, role: u.role, depot_id: u.depot_id },
    config.JWT_SECRET, { expiresIn: config.JWT_TTL });
  return { token, user: { username: u.username, role: u.role, depot_id: u.depot_id } };
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : null;
  // Emailed report links carry a signed ?token= (only accepted on report paths).
  if (!token && req.query && req.query.token && req.path.indexOf('/report/') >= 0) token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try { req.user = jwt.verify(token, config.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient role for this action' });
    next();
  };
}

module.exports = { seedDefaults, login, requireAuth, requireRole };
