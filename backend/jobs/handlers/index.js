// One module per SapJobKind (jobs/kinds.js), each exporting an async
// `({ job, adapter }) => outcome` where outcome is one of:
//   { done: true }   — resolved; release() marks the job succeeded
//   { done: false }  — not yet; release() reschedules at the kind's interval
//   throws           — release() applies backoff (jobs/backoff.js)
//
// `job.args` holds ids only (never a hydrated document — see the note in
// prisma/schema.prisma's SapJob model), so a handler's first job is always to
// rehydrate from the database inside the tenant binding the worker already
// applied before calling it.
//
const HANDLERS = {
  awaitGoodsReceipt: require('./awaitGoodsReceipt'),
  awaitPaymentRun: require('./awaitPaymentRun'),
  // Discovery sweeps (Phase 4) — recurring; see the note on `recurring` in
  // jobs/kinds.js for how their job-runtime lifecycle differs from the two
  // targeted watches above.
  sweepPurchaseOrders: require('./sweepPurchaseOrders'),
  sweepPayments: require('./sweepPayments'),
  sweepQuotations: require('./sweepQuotations'),
};

const handlerFor = (kind) => {
  const handler = HANDLERS[kind];
  if (!handler) throw new Error(`No job handler registered for SAP job kind "${kind}"`);
  return handler;
};

module.exports = { HANDLERS, handlerFor };
