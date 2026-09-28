'use strict';
// Two-factor codes for Google Authenticator / Microsoft Authenticator / Authy (RFC 6238, SHA-1, 6 digits, 30 s).
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) { value = (value << 5) | ALPHABET.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}
const stepOf = (ms) => Math.floor(ms / 1000 / 30);
function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

// Returns the accepted time-step (a number) or null. A step that was already used (<= lastStep) is refused,
// so a code that was shoulder-surfed or sniffed cannot be replayed within its 30-90 s lifetime.
function verify(secretB32, code, { lastStep = 0, now = Date.now(), window = 1 } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32); const cur = stepOf(now); let hit = null;
  for (let d = -window; d <= window; d++) {
    const step = cur + d; const want = hotp(key, step);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c)) && step > lastStep) hit = step;
  }
  return hit;
}
function otpauthUri({ issuer, account, secret }) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// One-time recovery codes for a lost phone. Only their SHA-256 is stored.
const sha = (s) => crypto.createHash('sha256').update(String(s).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
function newRecoveryCodes(n = 8) {
  const set = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const plain = [];
  for (let i = 0; i < n; i++) { let c = ''; for (let j = 0; j < 10; j++) c += set[crypto.randomInt(set.length)]; plain.push(c.slice(0, 5) + '-' + c.slice(5)); }
  return { plain, hashed: plain.map(sha) };
}
function useRecoveryCode(hashedList, code) {
  const h = sha(code); const i = (hashedList || []).findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
  if (i < 0) return null;
  const rest = hashedList.slice(); rest.splice(i, 1); return rest;
}

module.exports = { generateSecret, verify, otpauthUri, newRecoveryCodes, useRecoveryCode, base32Decode, base32Encode, hotp, stepOf };
