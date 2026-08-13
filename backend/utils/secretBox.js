const crypto = require('crypto');

// Authenticated symmetric encryption for anything that must be stored but never
// read back by a human: MFA secrets and, since Phase 4, SAP credentials.
//
// AES-256-GCM with a random 12-byte IV per message. Ciphertext is stored as a
// single self-describing string — `<version>:<iv>:<tag>:<ciphertext>`, all
// base64url. Two versions exist, and the prefix is what tells them apart:
//
//   v1 — encrypted directly under the master key. MFA secrets, written by
//        Phase 3, and still read and written as they were.
//   v2 — envelope encryption (Phase 4). A random 32-byte *data key* per client
//        encrypts the secret; the data key itself is wrapped as a v1 blob under
//        the master key and stored beside the ciphertext. Rotating the master
//        key means re-wrapping N small data keys rather than re-encrypting
//        every secret, and swapping in a KMS means replacing exactly two
//        functions — `wrapDataKey` and `unwrapDataKey` — because nothing else
//        ever touches the master key.
//
// Nothing here ever logs or returns plaintext.

const VERSION = 'v1';
const ENVELOPE_VERSION = 'v2';

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

// The primitive both versions share. `version` only labels the output — it is
// the caller's choice of key that makes a blob v1 or v2.
const seal = (key, version, plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);

  return [version, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join(':');
};

const open = (key, version, envelope) => {
  const [found, iv, tag, ciphertext] = String(envelope).split(':');
  if (found !== version || !iv || !tag || !ciphertext) {
    throw new Error('Cannot decrypt: unrecognised ciphertext envelope');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  // Throws if the ciphertext or the key is wrong — tampering is a failure, not
  // a silently different plaintext.
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
};

const encrypt = (plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return seal(masterKey(), VERSION, plaintext);
};

const decrypt = (envelope) => (envelope ? open(masterKey(), VERSION, envelope) : null);

const isEncrypted = (value) =>
  typeof value === 'string' && (value.startsWith(`${VERSION}:`) || value.startsWith(`${ENVELOPE_VERSION}:`));

// --- Envelope encryption (v2) ---------------------------------------------
//
// The two functions a KMS would replace. Today the master key lives in the
// process; tomorrow `wrapDataKey` is a `kms.Encrypt` call and `unwrapDataKey` a
// `kms.Decrypt`, and nothing that stores or reads a secret has to change,
// because the wrapped key is opaque to every caller.

const generateDataKey = () => crypto.randomBytes(32);

const wrapDataKey = (dataKey) => seal(masterKey(), VERSION, dataKey.toString('base64'));

const unwrapDataKey = (wrapped) => {
  const raw = Buffer.from(open(masterKey(), VERSION, wrapped), 'base64');
  if (raw.length !== 32) throw new Error('Cannot unwrap data key: wrong length');
  return raw;
};

/** Encrypts a secret under a client's data key. Returns a `v2:` blob. */
const encryptWithDataKey = (dataKey, plaintext) => {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return seal(dataKey, ENVELOPE_VERSION, plaintext);
};

const decryptWithDataKey = (dataKey, envelope) =>
  (envelope ? open(dataKey, ENVELOPE_VERSION, envelope) : null);

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  generateDataKey,
  wrapDataKey,
  unwrapDataKey,
  encryptWithDataKey,
  decryptWithDataKey,
  VERSION,
  ENVELOPE_VERSION,
};
