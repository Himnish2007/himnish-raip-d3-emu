#!/usr/bin/env node
'use strict';
// BREAK-GLASS: give a locked-out user (usually the only super admin) a way back in.
//
//   pm2 stop emu-d3                       # the app MUST be stopped, otherwise it would overwrite this change
//   node scripts/recover-admin.js admin   # prints a temporary password ONCE
//   pm2 start emu-d3
//
// What it does for that user: new random temporary password (must be changed at the next sign-in),
// two-step verification removed, account unlocked and enabled, every old session ended.
// It works on the same data the app uses (RDS if DATABASE_URL is set, else the local JSON file).
// Only someone who can log in to the server (and read .env) can run it, which is why it is safe.
require('dotenv').config();
const path = require('path');
const config = require(path.join('..', 'src', 'config'));
const { Store } = require(path.join('..', 'src', 'store'));
const { createDb } = require(path.join('..', 'src', 'db'));
const pw = require(path.join('..', 'src', 'password'));

(async () => {
  const username = process.argv[2];
  if (!username) { console.error('usage: node scripts/recover-admin.js <username>'); process.exit(2); }
  const store = new Store();
  let db = null;
  if (config.DATABASE_URL) { db = createDb(config.DATABASE_URL); await db.init(); store.attachDb(db); }
  await store.load();
  const u = store.getUser(username);
  if (!u) { console.error(`user "${username}" not found. Users: ${[...store.users.keys()].join(', ') || '(none)'}`); process.exit(1); }

  const temp = pw.randomPassword();
  u.hash = await pw.hash(temp); u.must_change = true; u.disabled = false;
  delete u.totp; delete u.totp_pending;
  u.token_version = (u.token_version || 0) + 1;            // ends every old session
  u.pw_changed_at = new Date().toISOString();
  store.logAudit({ user: 'server-console', action: 'recover_access', detail: username });
  store.logSecurity({ type: 'password_reset', user: username, ip: 'server-console', detail: 'recover-admin.js' });

  // save in both places the app reads from, and WAIT for the database write
  const snap = store._snapshot();
  clearTimeout(store._saveTimer); clearTimeout(store._slowTimer);
  const fs = require('fs');
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const file = store._file, tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 }); fs.renameSync(tmp, file);
  if (db) await db.saveState(snap);

  console.log('');
  console.log(`  User:                ${username}`);
  console.log(`  Temporary password:  ${temp}`);
  console.log('  Write it down now: it is not shown again. At the first sign-in the user must choose a new password.');
  console.log('  Two-step verification was removed (set it up again after signing in).');
  console.log('  Now start the app again:  pm2 start emu-d3');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('recovery failed:', e.message); process.exit(1); });
