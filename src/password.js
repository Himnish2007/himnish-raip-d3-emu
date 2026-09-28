'use strict';
// Password rules + hashing.
//  * scrypt (Node built-in) runs in the libuv thread pool, so many people signing in at once never
//    freeze the server (bcryptjs is pure JavaScript and blocks the event loop; RUT data would stall).
//  * Old bcrypt hashes still work and are upgraded to scrypt automatically at the next good login.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const N = 16384, R = 8, P = 1, KEYLEN = 32;       // ~100 ms, 16 MB per hash

const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'admin', 'administrator', 'himnish', 'himinsights',
  'railway', 'indianrailways', '123456', '12345678', 'abc123', 'iloveyou', 'changeme', 'change-me', 'changethis', 'secret'];

function policyError(password, username) {
  const pw = String(password || '');
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password is too long (max 128 characters).';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes < 3 && pw.length < 16) return 'Use at least 3 of: small letters, CAPITAL letters, digits, symbols (or a passphrase of 16+ characters).';
  const low = pw.toLowerCase();
  if (username && String(username).length >= 3 && low.includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  for (const w of COMMON) if (low.includes(w)) return `Password is too easy to guess (contains "${w}").`;
  if (/(.)\1{3,}/.test(pw)) return 'Password must not repeat the same character 4 times in a row.';
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|qwer|asdf|zxcv)/i.test(pw)) return 'Password must not contain an easy sequence like 1234 or abcd.';
  return null;
}

const b64 = (b) => Buffer.from(b).toString('base64');
function scryptAsync(pw, salt, n, r, p, len) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, len, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? reject(e) : resolve(k))));
}
async function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${b64(salt)}$${b64(key)}`;
}
function hashSync(password) {          // only for first-run seeding at startup
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P, maxmem: 128 * N * R * 2 });
  return `scrypt$${N}$${R}$${P}$${b64(salt)}$${b64(key)}`;
}
async function verify(password, stored) {
  const s = String(stored || '');
  try {
    if (s.startsWith('scrypt$')) {
      const [, n, r, p, salt, key] = s.split('$');
      const want = Buffer.from(key, 'base64');
      const got = await scryptAsync(password, Buffer.from(salt, 'base64'), +n, +r, +p, want.length);
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    }
    if (s.startsWith('$2')) return await bcrypt.compare(String(password), s);   // legacy hash from older versions
  } catch (e) { /* fall through */ }
  return false;
}
const needsUpgrade = (stored) => !String(stored || '').startsWith('scrypt$');

// Same work for "no such user" so response time does not reveal which usernames exist.
let DUMMY = null;
async function verifyDummy(password) { if (!DUMMY) DUMMY = hashSync('dummy-password-for-timing'); await verify(password, DUMMY); return false; }

// Random temporary password that always satisfies the policy (no look-alike characters).
function randomPassword() {
  const pick = (set) => set[crypto.randomInt(set.length)];
  const lo = 'abcdefghijkmnpqrstuvwxyz', up = 'ABCDEFGHJKLMNPQRSTUVWXYZ', di = '23456789', sy = '#$%*+-=?';
  for (let i = 0; i < 20; i++) {
    const chars = [pick(lo), pick(up), pick(di), pick(sy)];
    const all = lo + up + di;
    while (chars.length < 14) chars.push(pick(all));
    for (let j = chars.length - 1; j > 0; j--) { const k = crypto.randomInt(j + 1); [chars[j], chars[k]] = [chars[k], chars[j]]; }
    const pw = chars.join('');
    if (!policyError(pw, '')) return pw;
  }
  return 'Rq7#kLm2Xp9vTn';   // unreachable in practice
}

module.exports = { policyError, hash, hashSync, verify, needsUpgrade, verifyDummy, randomPassword };
