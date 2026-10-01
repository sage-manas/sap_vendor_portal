const logger = require('./logger');

// Work that must happen because of a request, but not on the request's clock.
//
// The motivating case is an endpoint that has to answer identically whether or
// not an account exists (forgot-password, registration). If it wrote a token
// and sent an email before answering for a real account, and answered at once
// for an unknown one, the SMTP round trip would be the tell. So the answer goes
// out first and the work runs after it.
//
// Failures are logged, never thrown: there is no response left to attach them
// to, and an unhandled rejection would take the process down. Work is tracked
// so a test (or a graceful shutdown) can wait for it with drainBackground().

const pending = new Set();

const runInBackground = (label, work) => {
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => logger.error(`[background:${label}] ${error.message}`))
    .finally(() => pending.delete(promise));
  pending.add(promise);
  return promise;
};

const drainBackground = async () => {
  while (pending.size) await Promise.all([...pending]);
};

module.exports = { runInBackground, drainBackground };
