const { runWithTenant } = require('../utils/tenantContext');
const { getSapAdapterForClient } = require('../sap');
const logger = require('../utils/logger');
const { jobKind } = require('./kinds');
const { nextRunAt } = require('./backoff');
const { claim, release, reapStale, enqueue } = require('./queue');
const { handlerFor: defaultHandlerFor } = require('./handlers');
const { markFailed, markOrphaned } = require('./syncState');
const { SAP_JOB_KINDS } = require('./kinds');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');

// Sync-state bookkeeping (Phase 3) is best-effort side-channel work, not the
// job's own result — a job kind Phase 4 adds without a document mapping
// (jobs/syncState.js's DOCUMENT_FOR_KIND) must not fail the job over it, so
// every call from here is swallowed and logged rather than left to propagate.
const trySyncState = async (fn, ...args) => {
  try {
    await fn(...args);
  } catch (error) {
    logger.warn(`[jobs] sync-state update failed: ${error.message}`);
  }
};

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// Processes one already-claimed job. The worker is just another caller of the
// adapter — tenant extension, circuit breaker, SapLog, stamp() all apply
// unchanged, because this binds a tenant and calls the adapter exactly like a
// controller does. Never bypass runWithTenant here.
//
// Swallows the handler's outcome/error into a release() call rather than
// rethrowing, so one job's failure never aborts the rest of a tick's batch —
// callers that want to assert on what happened read the job row back
// (`{ok, outcome}` is returned for tests that would rather not).
const processJob = async (job, { handlerFor = defaultHandlerFor } = {}) => {
  const spec = jobKind(job.kind);

  try {
    const outcome = await runWithTenant(job.clientId, async () => {
      const adapter = await getSapAdapterForClient(job.clientId);
      const handler = handlerFor(job.kind);
      return handler({ job, adapter });
    });

    if (outcome?.done) {
      await release(job, { status: 'succeeded' });
      return { ok: true, outcome };
    }

    // Not yet — the normal path for a poll: reschedule, do not touch error
    // state. Exhausting maxAttempts here means "SAP never answered", which is
    // a different operator question than SAP erroring, so it's `abandoned` —
    // and the document it was watching becomes `orphaned` (Phase 3).
    if (job.attempts >= job.maxAttempts) {
      const message = 'Exhausted maxAttempts — SAP never answered';
      await release(job, { status: 'abandoned', lastError: message });
      await runWithTenant(job.clientId, () => trySyncState(markOrphaned, job.kind, job.args, message));
    } else {
      await release(job, { runAt: nextRunAt({ spec, attempts: job.attempts, errored: false }), status: 'pending' });
    }
    return { ok: true, outcome };
  } catch (error) {
    logger.error(`[jobs] ${job.kind} (${job.pk}) errored: ${error.message}`);
    // A sweep tick (Phase 4, spec.recurring) that exhausts its own attempts
    // just sits `abandoned` — there is no single document to orphan, and the
    // next scheduled tick (materialiseSchedules(), a fresh job row per
    // due-tick) covers the vendor again regardless.
    if (job.attempts >= job.maxAttempts) {
      await release(job, { status: 'abandoned', lastError: error.message });
      if (!spec.recurring) {
        await runWithTenant(job.clientId, () => trySyncState(markOrphaned, job.kind, job.args, error.message));
      }
    } else {
      await release(job, {
        status: 'pending',
        runAt: nextRunAt({ spec, attempts: job.attempts, errored: true }),
        lastError: error.message,
      });
      // Phase 3: the job itself keeps retrying — this just records the last
      // error against the document for the reconciliation queue. No single
      // document for a sweep tick (spec.recurring) to record it against.
      if (!spec.recurring) {
        await runWithTenant(job.clientId, () => trySyncState(markFailed, job.kind, job.args, error.message));
      }
    }
    return { ok: false, error };
  }
};

// Discovery sweeps (Phase 4) are recurring: rather than one perpetual job row
// that reschedules itself forever, each due tick gets its own fresh SapJob —
// dedupeKey embeds the tick's own nextRunAt, so two workers racing
// materialiseSchedules() at the same moment still produce exactly one job
// (the upsert in enqueue()), and a slow/abandoned tick never blocks the next
// one from being created on schedule.
//
// Also bootstraps a SapSchedule row (enabled, at the kind's default
// interval) for every operational tenant that doesn't have one yet for a
// given recurring kind — there is no separate "turn sweeps on" step; a
// tenant becoming Trial/Active is enough. An operator who wants a kind off
// for one tenant can flip `enabled: false` directly; this only ever creates
// a *missing* row, never re-enables one that was turned off on purpose.
const materialiseSchedules = async () => withoutTenantScope(async () => {
  const recurringKinds = Object.entries(SAP_JOB_KINDS).filter(([, spec]) => spec.recurring);
  if (!recurringKinds.length) return;

  const tenants = await rawPrisma.client.findMany({
    where: { status: { in: ['Trial', 'Active'] } },
    select: { clientId: true },
  });

  for (const { clientId } of tenants) {
    for (const [kind, spec] of recurringKinds) {
      await rawPrisma.sapSchedule.upsert({
        where: { clientId_kind: { clientId, kind } },
        create: { clientId, kind, intervalMs: spec.defaultIntervalMs, enabled: true, nextRunAt: new Date() },
        update: {},
      });
    }
  }

  const due = await rawPrisma.sapSchedule.findMany({
    where: { enabled: true, nextRunAt: { lte: new Date() } },
  });

  for (const schedule of due) {
    const spec = SAP_JOB_KINDS[schedule.kind];
    if (!spec?.recurring) continue; // a schedule row for a kind this build no longer registers as recurring

    await enqueue({
      clientId: schedule.clientId,
      kind: schedule.kind,
      dedupeKey: `${schedule.kind}:${schedule.clientId}:${schedule.nextRunAt.getTime()}`,
      args: {},
      runAt: schedule.nextRunAt,
    });

    await rawPrisma.sapSchedule.update({
      where: { pk: schedule.pk },
      data: { lastRunAt: new Date(), nextRunAt: new Date(Date.now() + schedule.intervalMs) },
    });
  }
});

const tick = async (workerId = WORKER_ID, { limit = 20 } = {}) => {
  await reapStale();
  await materialiseSchedules();
  const jobs = await claim(workerId, limit);
  for (const job of jobs) {
    await processJob(job);
  }
  return jobs.length;
};

const TICK_MS = Number(process.env.JOBS_TICK_MS) || 5000;

let running = false;

const run = async () => {
  if (running) return;
  running = true;
  logger.info(`[jobs] worker ${WORKER_ID} starting, tick every ${TICK_MS}ms`);

  const loop = async () => {
    if (!running) return;
    try {
      await tick();
    } catch (error) {
      logger.error(`[jobs] tick errored: ${error.message}`);
    }
    if (!running) return;
    const timer = setTimeout(loop, TICK_MS);
    if (typeof timer.unref === 'function') timer.unref();
  };

  loop();
};

const stop = () => {
  running = false;
};

module.exports = { processJob, tick, materialiseSchedules, run, stop, WORKER_ID, TICK_MS };

// Entry point for `node jobs/worker.js` (the vendorconnect-jobs PM2 app).
// Gated on JOBS_ENABLED, default false, so importing this module — in tests
// or anywhere else — never starts a live loop by accident.
if (require.main === module) {
  if (process.env.JOBS_ENABLED === 'true') {
    run();
  } else {
    logger.warn('[jobs] JOBS_ENABLED is not "true" — worker process exiting without starting the loop.');
  }
}
