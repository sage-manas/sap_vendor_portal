const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { settingValue } = require('../config/tenantSettings');
const logger = require('../utils/logger');

// Retention (issue #128). Under Mongoose a TTL index purged SAP log rows after
// 30 days for free; the Postgres migration left nothing in its place, so
// `sap_logs` — the table holding the most sensitive payloads in the product —
// and `sap_jobs` grew without bound.
//
// Both purges are per tenant, driven by a recurring job of the same name (see
// jobs/kinds.js) and by a tenant setting (config/tenantSettings.js, group
// `retention`). They are deliberately narrow: AuditLog is a compliance record,
// append-only by REVOKE, and SapConnectionAudit likewise; neither is named here
// and neither is reachable from here.
//
// Deletes run in bounded batches. A first run on a long-lived database may have
// a very large backlog, and one `DELETE ... WHERE timestamp < x` over millions
// of rows holds locks the sweeps and the SAP-log screen would queue behind.
// Each batch is a short statement; the loop yields between them; and a run
// stops after `maxBatches`, leaving the rest to the next scheduled run rather
// than monopolising the worker's tick.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_MAX_BATCHES = 500;

// A job in any of these states will never run again.
const FINISHED_STATUSES = ['succeeded', 'failed', 'abandoned', 'cancelled'];

const settingsFor = async (clientId) => {
  const client = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId } }));
  return client;
};

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

const inBatches = async ({ findPks, remove, batchSize, maxBatches }) => {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const pks = await findPks(batchSize);
    if (!pks.length) return { deleted, complete: true };

    const { count } = await remove(pks);
    deleted += count;
    if (pks.length < batchSize) return { deleted, complete: true };

    await yieldToEventLoop();
  }
  return { deleted, complete: false };
};

const purgeSapLogs = async ({ clientId, now = Date.now(), batchSize = DEFAULT_BATCH_SIZE, maxBatches = DEFAULT_MAX_BATCHES }) => {
  const client = await settingsFor(clientId);
  const days = settingValue(client, 'retention.sapLogDays');
  const cutoff = new Date(now - days * DAY_MS);

  const result = await withoutTenantScope(() => inBatches({
    batchSize,
    maxBatches,
    findPks: async (take) => (await rawPrisma.sapLog.findMany({
      where: { clientId, timestamp: { lt: cutoff } },
      select: { pk: true },
      orderBy: { timestamp: 'asc' },
      take,
    })).map((row) => row.pk),
    remove: (pks) => rawPrisma.sapLog.deleteMany({ where: { clientId, pk: { in: pks } } }),
  }));

  logRun('SAP log rows', clientId, days, result);
  return result;
};

const purgeFinishedJobs = async ({ clientId, now = Date.now(), batchSize = DEFAULT_BATCH_SIZE, maxBatches = DEFAULT_MAX_BATCHES }) => {
  const client = await settingsFor(clientId);
  const days = settingValue(client, 'retention.finishedJobDays');
  const cutoff = new Date(now - days * DAY_MS);

  // `release()` updates the row with raw SQL, which does not touch Prisma's
  // client-side `updatedAt`; the job's real last activity is the latest of
  // these three, so all three have to be past the cutoff.
  const finishedBefore = {
    clientId,
    status: { in: FINISHED_STATUSES },
    updatedAt: { lt: cutoff },
    AND: [
      { OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }] },
      { OR: [{ succeededAt: null }, { succeededAt: { lt: cutoff } }] },
    ],
  };

  const result = await withoutTenantScope(() => inBatches({
    batchSize,
    maxBatches,
    findPks: async (take) => (await rawPrisma.sapJob.findMany({
      where: finishedBefore, select: { pk: true }, orderBy: { updatedAt: 'asc' }, take,
    })).map((row) => row.pk),
    remove: (pks) => rawPrisma.sapJob.deleteMany({ where: { ...finishedBefore, pk: { in: pks } } }),
  }));

  logRun('finished job rows', clientId, days, result);
  return result;
};

const logRun = (what, clientId, days, { deleted, complete }) => {
  if (!deleted && complete) return;
  const line = `[retention] ${clientId}: removed ${deleted} ${what} older than ${days} days${complete ? '' : ' — more remain, continuing at the next run'}`;
  if (complete) logger.info(line); else logger.warn(line);
};

module.exports = { purgeSapLogs, purgeFinishedJobs, FINISHED_STATUSES };
