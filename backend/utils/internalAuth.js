const crypto = require('crypto');

// A shared secret between our own processes only (vendorconnect-api and
// vendorconnect-jobs) — never exposed to a client, never stored, derived
// fresh each call from JWT_SECRET so both processes agree without a new
// required env var (the same pattern secretBox.js uses to derive a dev
// master key). Used solely to authenticate the loopback-only internal relay
// — see routes/internal.routes.js and jobs/notify.js for why it exists: the
// job worker has no Socket.io server of its own and asks the API process to
// emit on its behalf.
const internalKey = () =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret').update('internal-relay').digest('hex');

module.exports = { internalKey };
