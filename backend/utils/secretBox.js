const crypto = require('crypto');

// Authenticated symmetric encryption for anything that must be stored but never
// read back by a human: MFA secrets today, SAP credentials in Phase 4.
//
// AES-256-GCM with a random 12-byte IV per message. Ciphertext is stored as a
// single self-describing string — `v1:<iv>:<tag>:<ciphertext>`, all base64url —
// so the format can be versioned when Phase 4 introduces per-client data keys
// wrapped by this master key (envelope encryption). Nothing here ever logs or
// returns plaintext.

const VERSION = 'v1';

const masterKey = () => {
  const raw = process.env.MASTER_KEY || process.env.SECRET_MASTER_KEY;

  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MASTER_KEY is required in production: it encrypts MFA and SAP secrets at rest');
    }
    // Development and test derive a stable key from the JWT secret so a
    // developer does not have to configure two secrets to run the app. This is
    // deliberately unavailable in production, where the check above fires.
    return crypto.createHash('sha256').update(`dev-master-key:${process.env.JWT_SECRET || 'secret'}`).digest();
  }

  // Accept either 32 raw bytes as base64/hex, or any passphrase (hashed to 32).
  const decoded = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return decoded.length === 32 ? decoded : crypto.createHash('sha256').update(raw).digest();
};

const encrypt = (plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
};

const decrypt = (envelope) => {
  if (!envelope) return null;

  const [version, iv, tag, ciphertext] = String(envelope).split(':');
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error('Cannot decrypt: unrecognised ciphertext envelope');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  // Throws if the ciphertext or the key is wrong — tampering is a failure, not
  // a silently different plaintext.
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
};

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(`${VERSION}:`);

module.exports = { encrypt, decrypt, isEncrypted };
