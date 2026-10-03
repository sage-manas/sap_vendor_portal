const crypto = require('crypto');

// A shared secret between our own processes only (vendorconnect-api and
// vendorconnect-jobs) — never exposed to a client. Used solely to authenticate
// the loopback-only internal relay — see routes/internal.routes.js and
// jobs/notify.js for why it exists: the job worker has no Socket.io server of
// its own and asks the API process to emit on its behalf.
//
// It is its own secret (INTERNAL_KEY). It used to be derived from JWT_SECRET so
// nobody had to configure a second variable, which meant one leaked secret
// opened both the sessions and the relay. Production now requires both and
// refuses to boot if they are equal (config/validateEnv.js); development and
// test keep the derived key so a fresh checkout still runs with no setup.
const derivedDevKey = () =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update('internal-relay').digest('hex');

const internalKey = () => {
  if (process.env.INTERNAL_KEY) return process.env.INTERNAL_KEY;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('INTERNAL_KEY is required in production');
  }
  return derivedDevKey();
};

// Constant-time comparison. Both sides are hashed first so timingSafeEqual
// always sees equal-length buffers — comparing raw strings would either throw
// on a length mismatch or leak the length through the early return.
const isInternalKey = (candidate) => {
  if (typeof candidate !== 'string') return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(candidate), digest(internalKey()));
};

module.exports = { internalKey, isInternalKey };
