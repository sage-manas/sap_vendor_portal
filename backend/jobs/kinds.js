// Same discipline as config/sapTransactions.js — one registry, throws on
// anything unregistered. jobs/queue.js and jobs/worker.js read defaults from
// here rather than each hardcoding their own.
const SAP_JOB_KINDS = {
  awaitGoodsReceipt: {
    label: 'Await goods receipt',
    defaultIntervalMs: 30_000,
    defaultMaxAttempts: 240, // 2h at 30s
    recurring: false,
  },
  awaitPaymentRun: {
    label: 'Await payment run',
    defaultIntervalMs: 60_000,
    defaultMaxAttempts: 1440, // 24h at 60s
    recurring: false,
  },
  // Phase 4 adds the discovery sweeps here.
};

const jobKind = (key) => {
  const spec = SAP_JOB_KINDS[key];
  if (!spec) throw new Error(`Unknown SAP job kind "${key}"`);
  return spec;
};

module.exports = { SAP_JOB_KINDS, jobKind };
