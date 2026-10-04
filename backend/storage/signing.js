const crypto = require('crypto');

// Signed links for the local disk driver, which has no provider to presign for
// it. Same idea as an S3 presigned URL: the link itself is the credential, it
// names exactly one file in one tenant, and it stops working after a short time.
//
// The key is derived from JWT_SECRET, as the other process-local secrets in
// this codebase are, under its own label so a link signature is never a valid
// anything else.

const key = () => crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update('upload-link').digest();

const sign = ({ clientId, documentId, exp }) =>
  crypto.createHmac('sha256', key()).update(`${clientId}.${documentId}.${exp}`).digest('hex');

const verify = ({ clientId, documentId, exp, sig }, now = Date.now()) => {
  if (![clientId, documentId, exp, sig].every((part) => typeof part === 'string' && part)) return false;
  if (!/^\d{1,13}$/.test(exp) || Number(exp) * 1000 < now) return false;
  if (!/^[0-9a-f]+$/i.test(sig)) return false;

  const expected = Buffer.from(sign({ clientId, documentId, exp }), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

module.exports = { sign, verify };
