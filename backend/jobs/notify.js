const logger = require('../utils/logger');
const { internalKey } = require('../utils/internalAuth');

// The worker process has no Socket.io server of its own — see the note in
// routes/internal.routes.js. This is fire-and-forget: a realtime toast is
// not worth failing or retrying a job over, so every failure here is logged
// and swallowed rather than thrown.
//
// Silenced under test by default — nothing in the suite asserts on it, and
// there is usually no listening server at INTERNAL_API_URL during a test
// run. Set JOBS_NOTIFY_IN_TEST=true to exercise it deliberately.
const ENABLED = process.env.NODE_ENV !== 'test' || process.env.JOBS_NOTIFY_IN_TEST === 'true';

const baseUrl = () => process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 5000}`;

const emit = async (room, event, data) => {
  if (!ENABLED) return;
  try {
    const res = await fetch(`${baseUrl()}/internal/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': internalKey() },
      body: JSON.stringify({ room, event, data }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) logger.warn(`[jobs] internal emit "${event}" rejected: ${res.status}`);
  } catch (error) {
    logger.warn(`[jobs] internal emit "${event}" failed: ${error.message}`);
  }
};

const notifyVendor = (clientId, vendorId, event, data) => emit({ clientId, vendorId }, event, data);
const notifyProcurement = (clientId, event, data) => emit({ clientId }, event, data);

module.exports = { notifyVendor, notifyProcurement };
