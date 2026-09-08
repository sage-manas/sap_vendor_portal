const { runWithTenant } = require('../utils/tenantContext');
const { getSapAdapterForClient } = require('../sap');
const logger = require('../utils/logger');
const { jobKind } = require('./kinds');
const { nextRunAt } = require('./backoff');
const { claim, release, reapStale } = require('./queue');
const { handlerFor: defaultHandlerFor } = require('./handlers');

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
    // a different operator question than SAP erroring, so it's `abandoned`.
    if (job.attempts >= job.maxAttempts) {
      await release(job, { status: 'abandoned', lastError: 'Exhausted maxAttempts — SAP never answered' });
    } else {
      await release(job, { runAt: nextRunAt({ spec, attempts: job.attempts, errored: false }), status: 'pending' });
    }
    return { ok: true, outcome };
  } catch (error) {
    logger.error(`[jobs] ${job.kind} (${job.pk}) errored: ${error.message}`);
    if (job.attempts >= job.maxAttempts) {
      await release(job, { status: 'abandoned', lastError: error.message });
    } else {
      await release(job, {
        status: 'pending',
        runAt: nextRunAt({ spec, attempts: job.attempts, errored: true }),
        lastError: error.message,
      });
    }
    return { ok: false, error };
  }
};

// materialiseSchedules() is Phase 4's job — turning SapSchedule rows whose
// nextRunAt has passed into SapJob rows. Stubbed here so the tick shape is
// already right and Phase 4 only has to fill this in.
const materialiseSchedules = async () => {};

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
