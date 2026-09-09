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

  // Discovery sweeps (Phase 4) — find documents SAP created on its own,
  // without portal involvement. `recurring: true` marks a different shape
  // from the two above: jobs/worker.js's materialiseSchedules() creates a
  // fresh job row per due tick (dedupeKey embeds the tick's own scheduled
  // time), rather than one row that reschedules itself forever — so
  // `defaultMaxAttempts` here just bounds how hard *one tick* retries before
  // giving up on it; the next scheduled tick covers the vendor again
  // regardless, so there's no reason for a stuck tick to hold on long.
  //
  // `defaultIntervalMs` is the *outer heartbeat* — how often a fresh tick is
  // materialised, i.e. "does any vendor need attention yet" — not the
  // per-vendor cadence. That's deliberately fast and cheap: the real cost
  // control is jobs/adaptivePolling.js's per-vendor SapSyncCursor gating
  // inside the handler (fast lane 30-60s, normal 5-15min, slow 1h-24h), plus
  // jobs/fingerprint.js skipping a write/event entirely when nothing
  // changed. The plan's per-feed "5 min / 30 min / daily" defaults are what
  // a quiet vendor settles into via that gating, not a property of this
  // outer tick.
  sweepPurchaseOrders: {
    label: 'Sweep purchase orders',
    feed: 'po',
    defaultIntervalMs: 60_000,
    defaultMaxAttempts: 5,
    recurring: true,
  },
  sweepPayments: {
    label: 'Sweep payments',
    feed: 'payment',
    defaultIntervalMs: 60_000,
    defaultMaxAttempts: 5,
    recurring: true,
  },
  sweepQuotations: {
    label: 'Sweep quotations',
    feed: 'quotation',
    defaultIntervalMs: 60_000,
    defaultMaxAttempts: 5,
    recurring: true,
  },
};

const jobKind = (key) => {
  const spec = SAP_JOB_KINDS[key];
  if (!spec) throw new Error(`Unknown SAP job kind "${key}"`);
  return spec;
};

module.exports = { SAP_JOB_KINDS, jobKind };
