// Deferred SAP answers are "waiting for a human/batch elsewhere", not "the
// server is struggling" — so the base case is a flat poll interval, and
// exponential backoff applies only to *errors*. awaitPaymentRun polling every
// 60s for 24 hours is normal and healthy — SAP genuinely has not paid yet.
// That must not be treated as failure and backed off into uselessness. Only a
// thrown error backs off.
const nextRunAt = ({ spec, attempts, errored }) => {
  if (!errored) return new Date(Date.now() + spec.defaultIntervalMs);
  const backoff = Math.min(spec.defaultIntervalMs * 2 ** Math.min(attempts, 6), 15 * 60_000);
  const jitter = backoff * (0.8 + Math.random() * 0.4); // +/-20%, avoid thundering herd
  return new Date(Date.now() + jitter);
};

module.exports = { nextRunAt };
