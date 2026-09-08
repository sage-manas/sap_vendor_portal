const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { jobKind } = require('./kinds');

// The unique constraint on dedupeKey is the idempotency guarantee: two
// requests that both try to watch the same document produce one row, not
// two. `update: {}` means an existing watch is not restarted by a duplicate
// request — its attempts/backoff state is left exactly as it was.
const enqueue = async ({ clientId, kind, dedupeKey, args, runAt = new Date() }) => {
  const spec = jobKind(kind);
  return withoutTenantScope(() => rawPrisma.sapJob.upsert({
    where: { dedupeKey },
    create: {
      clientId, kind, dedupeKey, args, runAt,
      maxAttempts: spec.defaultMaxAttempts,
    },
    update: {},
  }));
};

// Postgres' own queue primitive: FOR UPDATE SKIP LOCKED is what makes N
// workers safe. Two workers running this concurrently get disjoint sets — no
// coordination, no lock service, no double-execution.
const claim = (workerId, limit = 20) => withoutTenantScope(() => rawPrisma.$queryRaw`
  UPDATE "sap_jobs" SET
    status = 'running',
    "lockedBy" = ${workerId},
    "lockedAt" = now(),
    attempts = attempts + 1,
    "lastRunAt" = now()
  WHERE pk IN (
    SELECT pk FROM "sap_jobs"
    WHERE status = 'pending' AND "runAt" <= now()
    ORDER BY "runAt" ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *`);

// The completion path. `status` is one of pending (retry later) | succeeded |
// failed (errored, will retry until maxAttempts) | abandoned (maxAttempts
// exhausted with no answer) | cancelled.
const release = (job, { status, runAt, lastError = null }) => withoutTenantScope(() => rawPrisma.sapJob.update({
  where: { pk: job.pk },
  data: {
    status,
    runAt: runAt || job.runAt,
    lastError,
    ...(status === 'succeeded' ? { succeededAt: new Date() } : {}),
  },
}));

// Jobs `running` with `lockedAt` older than a lease timeout go back to
// `pending` — this is how a worker killed mid-job recovers. Run at the top of
// every tick. The lease is 5x the fastest job's interval, generous enough
// that a live worker never trips it under normal load.
const LEASE_MS = 5 * 60_000;

const reapStale = () => withoutTenantScope(() => rawPrisma.sapJob.updateMany({
  where: { status: 'running', lockedAt: { lt: new Date(Date.now() - LEASE_MS) } },
  data: { status: 'pending', lockedBy: null, lockedAt: null },
}));

// Resets an abandoned/failed job back to pending, as if it had never been
// attempted — the operator-facing retry, shared by the platform jobs board
// (an operator picks a job directly) and the reconciliation queue (an
// operator picks a document, which resolves to the job watching it). Returns
// null if the pk doesn't exist, so callers can 404 rather than upsert one
// into existence.
const retryByPk = async (pk) => {
  const existing = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk } }));
  if (!existing) return null;
  return withoutTenantScope(() => rawPrisma.sapJob.update({
    where: { pk },
    data: { status: 'pending', runAt: new Date(), attempts: 0, lastError: null, lockedBy: null, lockedAt: null },
  }));
};

module.exports = { enqueue, claim, release, reapStale, retryByPk, LEASE_MS };
