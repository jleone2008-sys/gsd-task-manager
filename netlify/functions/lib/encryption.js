// AES-256-GCM encrypt/decrypt for storing OAuth refresh tokens.
//
// Layout: 12-byte IV | 16-byte GCM tag | ciphertext — base64-encoded.
// hexKey must be the 64-char hex string of ADMIN_ENCRYPTION_KEY.
//
// Replaces the byte-identical copies that lived in ~8 different
// Netlify Functions before this consolidation.

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

function encryptToken(plaintext, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptToken(b64, hexKey) {
  const buf = Buffer.from(b64, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const key = Buffer.from(hexKey, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = { encryptToken, decryptToken };
