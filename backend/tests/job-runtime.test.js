const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope, getTenantId } = require('../utils/tenantContext');
const { enqueue, claim, release, reapStale } = require('../jobs/queue');
const { processJob, materialiseSchedules } = require('../jobs/worker');
const { seedClient } = require('./helpers');

const CLIENT_A = 'CLT-0001';
const CLIENT_B = 'CLT-JOBTEST-B';

const makeArgs = (suffix) => ({ clientId: CLIENT_A, kind: 'awaitGoodsReceipt', dedupeKey: `awaitGoodsReceipt:${CLIENT_A}:ASN-${suffix}`, args: { asnId: `ASN-${suffix}` } });

describe('jobs/queue', () => {
  test('enqueuing twice with the same dedupeKey produces one row', async () => {
    const spec = makeArgs('dupe');
    await enqueue(spec);
    await enqueue(spec);

    const rows = await withoutTenantScope(() => rawPrisma.sapJob.findMany({ where: { dedupeKey: spec.dedupeKey } }));
    expect(rows).toHaveLength(1);
  });

  test('a duplicate enqueue does not restart an in-flight watch', async () => {
    const spec = makeArgs('inflight');
    const first = await enqueue(spec);
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { pk: first.pk }, data: { attempts: 3, lastError: 'x' } }));

    await enqueue(spec);

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: first.pk } }));
    expect(row.attempts).toBe(3);
    expect(row.lastError).toBe('x');
  });

  test('two concurrent claim() calls return disjoint sets', async () => {
    await Promise.all([1, 2, 3, 4].map((n) => enqueue(makeArgs(`concurrent-${n}`))));

    const [batchA, batchB] = await Promise.all([
      claim('worker-a', 2),
      claim('worker-b', 2),
    ]);

    const idsA = batchA.map((j) => j.pk);
    const idsB = batchB.map((j) => j.pk);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    expect(idsA.length + idsB.length).toBeGreaterThan(0);
  });

  // Issue #68: release() used to write by pk alone. A worker whose call
  // outlasts its lease (reaper reclaims it, or a second worker claims and
  // finishes it) must not be able to overwrite that new owner's terminal
  // state when its own slow call finally returns.
  test('release() is a no-op once another worker holds the lease', async () => {
    await enqueue(makeArgs('cas-race'));
    const [staleJob] = await claim('worker-cas-race', 1);

    // Simulate the lease changing hands: the reaper returned it to pending,
    // a second worker claimed it, and that worker already finished it.
    await withoutTenantScope(() => rawPrisma.sapJob.update({
      where: { pk: staleJob.pk },
      data: { status: 'succeeded', lockedBy: null, lockedAt: null, succeededAt: new Date() },
    }));

    // The first (stale) worker's own call now finally returns and tries to
    // release with the job object it claimed — carrying its own, now-stale
    // lockedBy.
    const held = await release(staleJob, { status: 'abandoned', lastError: 'stale timeout' });

    expect(held).toBe(false);
    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: staleJob.pk } }));
    expect(row.status).toBe('succeeded');
    expect(row.lastError).toBeNull();
  });

  test('release() succeeds and clears the lease while this worker still holds it', async () => {
    await enqueue(makeArgs('cas-normal'));
    const [job] = await claim('worker-cas-normal', 1);

    const held = await release(job, { status: 'succeeded' });

    expect(held).toBe(true);
    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('succeeded');
    expect(row.lockedBy).toBeNull();
    expect(row.succeededAt).not.toBeNull();
  });

  test('reapStale() returns a stale running job to pending', async () => {
    const job = await enqueue(makeArgs('stale'));
    await withoutTenantScope(() => rawPrisma.sapJob.update({
      where: { pk: job.pk },
      data: { status: 'running', lockedBy: 'dead-worker', lockedAt: new Date(Date.now() - 10 * 60_000) },
    }));

    await reapStale();

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('pending');
    expect(row.lockedBy).toBeNull();
  });
});

describe('jobs/worker processJob', () => {
  const claimOne = async (spec) => {
    const enqueued = await enqueue(spec);
    const [claimed] = await claim(`test-${Math.random()}`, 1);
    // Another job from an earlier test in this suite could be claimed first —
    // pull specifically the one this test just made.
    if (claimed?.pk === enqueued.pk) return claimed;
    return withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: enqueued.pk } }));
  };

  test('handler returning { done: false } reschedules to pending with no error', async () => {
    const job = await claimOne(makeArgs('notyet'));
    const handlerFor = () => async () => ({ done: false });

    await processJob(job, { handlerFor });

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('pending');
    expect(row.lastError).toBeNull();
    expect(row.runAt.getTime()).toBeGreaterThan(job.runAt.getTime());
  });

  test('handler resolving { done: true } marks the job succeeded', async () => {
    const job = await claimOne(makeArgs('found'));
    const handlerFor = () => async () => ({ done: true });

    await processJob(job, { handlerFor });

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('succeeded');
    expect(row.succeededAt).not.toBeNull();
  });

  test('a thrown error applies backoff, increments attempts (via claim) and sets lastError', async () => {
    const job = await claimOne(makeArgs('errors'));
    const handlerFor = () => async () => { throw new Error('SAP said no'); };

    await processJob(job, { handlerFor });

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1); // claim() already incremented it
    expect(row.lastError).toBe('SAP said no');
    expect(row.runAt.getTime()).toBeGreaterThan(job.runAt.getTime());
  });

  test('exhausting maxAttempts abandons the job rather than failing it', async () => {
    const spec = makeArgs('exhausted');
    const enqueued = await enqueue(spec);
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { pk: enqueued.pk }, data: { maxAttempts: 1 } }));
    const [job] = await claim('exhaust-worker', 1);

    const handlerFor = () => async () => ({ done: false });
    await processJob(job, { handlerFor });

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: enqueued.pk } }));
    expect(row.status).toBe('abandoned');
    expect(row.status).not.toBe('failed');
  });

  test('exhausting maxAttempts on an error also abandons, with the error recorded', async () => {
    const spec = makeArgs('exhausted-error');
    const enqueued = await enqueue(spec);
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { pk: enqueued.pk }, data: { maxAttempts: 1 } }));
    const [job] = await claim('exhaust-worker-2', 1);

    const handlerFor = () => async () => { throw new Error('never came back'); };
    await processJob(job, { handlerFor });

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: enqueued.pk } }));
    expect(row.status).toBe('abandoned');
    expect(row.lastError).toBe('never came back');
  });

  // Issue #68's reproduction: worker 1 claims a job, its handler is still
  // running when the lease is considered lost (reaped, or claimed and
  // finished by a second worker); worker 1's handler then finally settles.
  // Its processJob() call must not revert the second worker's terminal
  // state.
  test('a lease lost mid-handler leaves the second worker\'s result alone', async () => {
    const job = await claimOne(makeArgs('two-workers'));

    const handlerFor = () => async () => {
      // While worker 1's handler is "still running" the lease changes hands
      // and a second worker completes the same job for real.
      await withoutTenantScope(() => rawPrisma.sapJob.update({
        where: { pk: job.pk },
        data: { status: 'succeeded', lockedBy: null, lockedAt: null, succeededAt: new Date() },
      }));
      return { done: true };
    };

    await processJob(job, { handlerFor });

    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('succeeded');
    expect(row.lastError).toBeNull();
  });

  // Suggested fix's second half: a handler racing another worker to the same
  // deterministic SAP id resolves the job as succeeded, not failed — the
  // document is already there, just written by the worker that won.
  test('a duplicate-key error from a handler resolves the job as succeeded, not failed', async () => {
    const job = await claimOne(makeArgs('dupe-key'));
    const handlerFor = () => async () => {
      const err = new Error('Unique constraint failed on the fields: (`id`)');
      err.code = 'P2002';
      throw err;
    };

    const result = await processJob(job, { handlerFor });

    expect(result.ok).toBe(true);
    const row = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: job.pk } }));
    expect(row.status).toBe('succeeded');
  });

  test('the handler runs with the job\'s tenant bound, not the caller\'s', async () => {
    await seedClient({ clientId: CLIENT_B, slug: 'jobtest-b', companyName: 'Job Test B' });
    const spec = { clientId: CLIENT_B, kind: 'awaitGoodsReceipt', dedupeKey: `awaitGoodsReceipt:${CLIENT_B}:ASN-tenant`, args: {} };
    const job = await claimOne(spec);

    let seenTenant = null;
    const handlerFor = () => async () => {
      seenTenant = getTenantId();
      return { done: true };
    };

    await processJob(job, { handlerFor });

    expect(seenTenant).toBe(CLIENT_B);
  });
});

describe('jobs/worker materialiseSchedules (Phase 4 recurring sweeps)', () => {
  test('bootstraps an enabled SapSchedule row per recurring kind for an operational tenant', async () => {
    await materialiseSchedules();

    const schedules = await withoutTenantScope(() => rawPrisma.sapSchedule.findMany({ where: { clientId: CLIENT_A } }));
    const kinds = schedules.map((s) => s.kind).sort();
    expect(kinds).toEqual(['sweepInvoices', 'sweepPayments', 'sweepPurchaseOrders', 'sweepQuotations']);
    expect(schedules.every((s) => s.enabled)).toBe(true);
  });

  test('never re-enables a schedule an operator turned off on purpose', async () => {
    await materialiseSchedules(); // bootstrap
    await withoutTenantScope(() => rawPrisma.sapSchedule.updateMany({
      where: { clientId: CLIENT_A, kind: 'sweepQuotations' }, data: { enabled: false },
    }));

    await materialiseSchedules(); // must not touch the disabled row

    const schedule = await withoutTenantScope(() => rawPrisma.sapSchedule.findFirst({
      where: { clientId: CLIENT_A, kind: 'sweepQuotations' },
    }));
    expect(schedule.enabled).toBe(false);
  });

  test('enqueues a job for a due schedule and advances its nextRunAt', async () => {
    await materialiseSchedules(); // bootstrap
    await withoutTenantScope(() => rawPrisma.sapSchedule.updateMany({
      where: { clientId: CLIENT_A, kind: 'sweepPurchaseOrders' },
      data: { nextRunAt: new Date(Date.now() - 1000) },
    }));

    await materialiseSchedules();

    const jobs = await withoutTenantScope(() => rawPrisma.sapJob.findMany({
      where: { clientId: CLIENT_A, kind: 'sweepPurchaseOrders' },
    }));
    expect(jobs.length).toBeGreaterThanOrEqual(1);

    const schedule = await withoutTenantScope(() => rawPrisma.sapSchedule.findFirst({
      where: { clientId: CLIENT_A, kind: 'sweepPurchaseOrders' },
    }));
    expect(schedule.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('a not-yet-due schedule enqueues nothing new', async () => {
    await materialiseSchedules(); // bootstrap, nextRunAt defaults to "now" — let it settle once
    await withoutTenantScope(() => rawPrisma.sapJob.deleteMany({ where: { clientId: CLIENT_A, kind: 'sweepPayments' } }));
    await withoutTenantScope(() => rawPrisma.sapSchedule.updateMany({
      where: { clientId: CLIENT_A, kind: 'sweepPayments' },
      data: { nextRunAt: new Date(Date.now() + 60_000) },
    }));

    await materialiseSchedules();

    const jobs = await withoutTenantScope(() => rawPrisma.sapJob.findMany({
      where: { clientId: CLIENT_A, kind: 'sweepPayments' },
    }));
    expect(jobs).toHaveLength(0);
  });
});
