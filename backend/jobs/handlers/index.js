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
// Awaiting driver rewiring (docs/04-sap-runtime-engineering-plan.md Phase
// 1.6) — the actual awaitGoodsReceipt/awaitPaymentRun handlers land here once
// the drivers' poll()/setTimeout timers are converted to one-shot probes.
const HANDLERS = {};

const handlerFor = (kind) => {
  const handler = HANDLERS[kind];
  if (!handler) throw new Error(`No job handler registered for SAP job kind "${kind}"`);
  return handler;
};

module.exports = { HANDLERS, handlerFor };
