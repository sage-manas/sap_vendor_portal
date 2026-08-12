const crypto = require('crypto');

// RFC 6238 TOTP (and RFC 4226 HOTP underneath), implemented on node's crypto
// rather than pulling in a dependency for ~60 lines of arithmetic. Compatible
// with Google Authenticator, 1Password, Authy: SHA-1, 6 digits, 30-second step.

const DIGITS = 6;
const STEP_SECONDS = 30;
// One step either side, so a code entered as it rolls over still works. Wider
// windows trade replay resistance for convenience; one step is the usual floor.
const WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
};

const base32Decode = (input) => {
  const cleaned = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

// 20 bytes = the SHA-1 block size RFC 4226 recommends.
const generateSecret = () => base32Encode(crypto.randomBytes(20));

const hotp = (secret, counter) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
};

const counterAt = (when = Date.now()) => Math.floor(when / 1000 / STEP_SECONDS);

const generateToken = (secret, when = Date.now()) => hotp(secret, counterAt(when));

/**
 * Verifies a user-entered code against the secret, tolerating one step of
 * clock drift either way. Comparison is constant-time so a code cannot be
 * discovered by timing the response.
 */
const verifyToken = (secret, token, when = Date.now()) => {
  const candidate = String(token || '').replace(/\D/g, '');
  if (candidate.length !== DIGITS || !secret) return false;

  const counter = counterAt(when);
  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = hotp(secret, counter + drift);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return true;
  }
  return false;
};

/**
 * The otpauth:// URI an authenticator app scans. Contains the shared secret, so
 * it is returned exactly once — at enrolment — and never logged or audited.
 */
const otpauthUrl = ({ secret, account, issuer = 'VendorConnect' }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

module.exports = { generateSecret, generateToken, verifyToken, otpauthUrl, DIGITS, STEP_SECONDS };
