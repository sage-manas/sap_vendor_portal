const request = require('supertest');
const buildTestApp = require('./testApp');
const { createAdminUser, seedClient } = require('./helpers');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { enqueue, claim } = require('../jobs/queue');
const { processJob, materialiseSchedules } = require('../jobs/worker');
const { SAP_JOB_KINDS } = require('../jobs/kinds');
const { purgeSapLogs, purgeFinishedJobs } = require('../jobs/retention');

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

// 2.2 / issue #128 — sap_logs and sap_jobs grew without bound after the
// Postgres migration dropped Mongo's TTL index. sap_logs holds the most
// sensitive payloads in the system, so retention is a data-minimisation
// control as well as a disk one. A recurring job per tenant now removes rows
// past a configurable age: SAP logs after 90 days, finished jobs after 14.

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY);
const OTHER = 'CLT-0002';

// Historical rows: the one thing no API can produce is a row that is already
// old, so the age is set directly. Everything else about retention — the
// policy, the schedule, the run — goes through the product's own paths.
const addLog = (clientId, ageDays, extra = {}) => withoutTenantScope(() => rawPrisma.sapLog.create({
  data: { clientId, vendorId: 'v1', type: 'OData', direction: 'OUTBOUND', name: 'TEST', status: 'SUCCESS', timestamp: daysAgo(ageDays), ...extra },
}));
const logCount = (clientId) => withoutTenantScope(() => rawPrisma.sapLog.count({ where: { clientId } }));

const addJob = (clientId, status, ageDays, n) => withoutTenantScope(() => rawPrisma.sapJob.create({
  data: {
    clientId, kind: 'awaitGoodsReceipt', dedupeKey: `awaitGoodsReceipt:${clientId}:${status}-${ageDays}-${n}`, args: {},
    status, updatedAt: daysAgo(ageDays),
  },
}));
const jobCount = (clientId, where = {}) => withoutTenantScope(() => rawPrisma.sapJob.count({ where: { clientId, ...where } }));

beforeEach(async () => {
  await seedClient();
  await seedClient({ clientId: OTHER, slug: 'other', companyName: 'Other Ltd' });
});

describe('purgeSapLogs', () => {
  it('removes rows older than 90 days by default and keeps newer ones', async () => {
    await addLog('CLT-0001', 120);
    await addLog('CLT-0001', 91);
    await addLog('CLT-0001', 89);
    await addLog('CLT-0001', 1);

    const { deleted } = await purgeSapLogs({ clientId: 'CLT-0001' });

    expect(deleted).toBe(2);
    expect(await logCount('CLT-0001')).toBe(2);
  });

  it('never touches another tenant, whatever its rows\' age', async () => {
    await addLog('CLT-0001', 200);
    await addLog(OTHER, 200);

    await purgeSapLogs({ clientId: 'CLT-0001' });

    expect(await logCount('CLT-0001')).toBe(0);
    expect(await logCount(OTHER)).toBe(1);
  });

  it('removes every old row even when there are more than one batch', async () => {
    for (let n = 0; n < 7; n += 1) await addLog('CLT-0001', 100 + n);
    await addLog('CLT-0001', 2);

    const { deleted } = await purgeSapLogs({ clientId: 'CLT-0001', batchSize: 3 });

    expect(deleted).toBe(7);
    expect(await logCount('CLT-0001')).toBe(1);
  });

  it('stops after its batch budget and leaves the rest for the next run rather than holding the worker', async () => {
    for (let n = 0; n < 6; n += 1) await addLog('CLT-0001', 100 + n);

    const { deleted, complete } = await purgeSapLogs({ clientId: 'CLT-0001', batchSize: 2, maxBatches: 2 });

    expect(deleted).toBe(4);
    expect(complete).toBe(false);
    expect(await logCount('CLT-0001')).toBe(2);
  });

  it('leaves the audit trail and the SAP connection audit alone', async () => {
    const audit = await withoutTenantScope(() => rawPrisma.auditLog.create({
      data: { clientId: 'CLT-0001', actorId: 'a', actorRole: 'client_admin', plane: 'tenant', action: 'settings.updated', at: daysAgo(400) },
    }));
    await addLog('CLT-0001', 400);

    await purgeSapLogs({ clientId: 'CLT-0001' });
    await purgeFinishedJobs({ clientId: 'CLT-0001' });

    expect(await withoutTenantScope(() => rawPrisma.auditLog.findUnique({ where: { pk: audit.pk } }))).not.toBeNull();
  });
});

describe('purgeFinishedJobs', () => {
  it('removes finished jobs older than 14 days, whatever way they finished', async () => {
    await addJob('CLT-0001', 'succeeded', 20, 1);
    await addJob('CLT-0001', 'failed', 20, 1);
    await addJob('CLT-0001', 'abandoned', 20, 1);
    await addJob('CLT-0001', 'cancelled', 20, 1);
    await addJob('CLT-0001', 'succeeded', 3, 1);

    const { deleted } = await purgeFinishedJobs({ clientId: 'CLT-0001' });

    expect(deleted).toBe(4);
    expect(await jobCount('CLT-0001')).toBe(1);
  });

  it('never removes work that is still to be done, however old', async () => {
    await addJob('CLT-0001', 'pending', 60, 1);
    await addJob('CLT-0001', 'running', 60, 1);

    const { deleted } = await purgeFinishedJobs({ clientId: 'CLT-0001' });

    expect(deleted).toBe(0);
    expect(await jobCount('CLT-0001')).toBe(2);
  });

  it('does not remove another tenant\'s jobs', async () => {
    await addJob(OTHER, 'succeeded', 60, 1);
    await purgeFinishedJobs({ clientId: 'CLT-0001' });
    expect(await jobCount(OTHER)).toBe(1);
  });
});

describe('retention is a per-tenant setting', () => {
  const setRetention = (token, settings) => request(app).patch('/api/workspace/settings').set(auth(token)).send({ settings });

  it('is configurable by a workspace admin, and the job honours it', async () => {
    const { token } = await createAdminUser();
    const res = await setRetention(token, { 'retention.sapLogDays': 30, 'retention.finishedJobDays': 2 });
    expect(res.status).toBe(200);

    await addLog('CLT-0001', 45);
    await addLog('CLT-0001', 10);
    await addJob('CLT-0001', 'succeeded', 5, 1);
    await addJob('CLT-0001', 'succeeded', 1, 1);

    expect((await purgeSapLogs({ clientId: 'CLT-0001' })).deleted).toBe(1);
    expect((await purgeFinishedJobs({ clientId: 'CLT-0001' })).deleted).toBe(1);
  });

  it('applies to the tenant that set it and not to another', async () => {
    const { token } = await createAdminUser();
    await setRetention(token, { 'retention.sapLogDays': 7 });
    await addLog(OTHER, 20);

    await purgeSapLogs({ clientId: OTHER });

    expect(await logCount(OTHER)).toBe(1);
  });

  it('refuses a period short enough to make the SAP log useless', async () => {
    const { token } = await createAdminUser();
    const res = await setRetention(token, { 'retention.sapLogDays': 0 });
    expect(res.status).toBe(400);
    expect(res.body.errors['retention.sapLogDays']).toBeDefined();
  });

  it('is described in the settings screen\'s registry with its default', async () => {
    const { token } = await createAdminUser();
    const res = await request(app).get('/api/workspace/settings').set(auth(token));
    const settings = res.body.groups.flatMap((group) => group.settings);
    expect(settings.find((s) => s.key === 'retention.sapLogDays')).toMatchObject({ value: 90, default: 90 });
    expect(settings.find((s) => s.key === 'retention.finishedJobDays')).toMatchObject({ value: 14, default: 14 });
  });
});

describe('the worker runs them', () => {
  it('registers both as recurring, daily jobs', () => {
    for (const kind of ['purgeSapLogs', 'purgeFinishedJobs']) {
      expect(SAP_JOB_KINDS[kind]).toMatchObject({ recurring: true, defaultIntervalMs: DAY });
    }
  });

  it('schedules both for an operational tenant', async () => {
    await materialiseSchedules();
    const schedules = await withoutTenantScope(() => rawPrisma.sapSchedule.findMany({ where: { clientId: 'CLT-0001' } }));
    expect(schedules.map((s) => s.kind)).toEqual(expect.arrayContaining(['purgeSapLogs', 'purgeFinishedJobs']));
  });

  it('purges when a due tick is processed, and marks the tick succeeded without needing SAP', async () => {
    await addLog('CLT-0001', 100);
    await enqueue({ clientId: 'CLT-0001', kind: 'purgeSapLogs', dedupeKey: 'purgeSapLogs:CLT-0001:tick', args: {} });
    const [job] = await claim('retention-test', 5);

    const result = await processJob(job);

    expect(result.ok).toBe(true);
    expect(await logCount('CLT-0001')).toBe(0);
    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('succeeded');
  });

  it('does not delete the job that is running it', async () => {
    await enqueue({ clientId: 'CLT-0001', kind: 'purgeFinishedJobs', dedupeKey: 'purgeFinishedJobs:CLT-0001:tick', args: {} });
    const [job] = await claim('retention-test', 5);
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { pk: job.pk }, data: { updatedAt: daysAgo(30) } }));

    await processJob(job);

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row).not.toBeNull();
  });
});
