'use strict';

// ---------------------------------------------------------------------------
// Small helper to store a reversible secret (e.g. the dashboard-editable SMTP
// password) encrypted at rest, instead of plain text in the state file / DB
// snapshot. Key is derived from JWT_SECRET so no extra env var is required.
// NOTE: this is "encrypted at rest in the data file", not a vault - anyone
// with JWT_SECRET + the state file can still decrypt it, same trust boundary
// as the server .env already has today.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const config = require('./config');

function deriveKey() {
  return crypto.createHash('sha256').update('raip-smtp:' + String(config.JWT_SECRET)).digest();
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return ''; // wrong key (JWT_SECRET changed) or corrupt blob - fail safe, not fatal
  }
}

module.exports = { encrypt, decrypt };
