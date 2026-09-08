// Dual identity / sync state — Phase 3 of docs/04-sap-runtime-engineering-plan.md.
const fs = require('fs');
const path = require('path');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { SAP_SYNC_STATE, isLegalSyncTransition } = require('../config/statuses');
const { markPending, markSynced, markFailed, markOrphaned } = require('../jobs/syncState');
const { processJob } = require('../jobs/worker');
const { enqueue, claim } = require('../jobs/queue');

describe('SAP_SYNC_STATE legal transitions', () => {
  it('local only ever becomes pending', () => {
    expect(isLegalSyncTransition('local', 'pending')).toBe(true);
    expect(isLegalSyncTransition('local', 'synced')).toBe(false);
    expect(isLegalSyncTransition('local', 'failed')).toBe(false);
    expect(isLegalSyncTransition('local', 'orphaned')).toBe(false);
  });

  it('synced never regresses', () => {
    for (const to of ['local', 'pending', 'failed', 'orphaned']) {
      expect(isLegalSyncTransition('synced', to)).toBe(false);
    }
  });

  it('pending can resolve to synced, failed or orphaned', () => {
    expect(isLegalSyncTransition('pending', 'synced')).toBe(true);
    expect(isLegalSyncTransition('pending', 'failed')).toBe(true);
    expect(isLegalSyncTransition('pending', 'orphaned')).toBe(true);
    expect(isLegalSyncTransition('pending', 'local')).toBe(false);
  });

  it('failed and orphaned can retry to pending or resolve straight to synced', () => {
    for (const from of ['failed', 'orphaned']) {
      expect(isLegalSyncTransition(from, 'pending')).toBe(true);
      expect(isLegalSyncTransition(from, 'synced')).toBe(true);
      expect(isLegalSyncTransition(from, 'local')).toBe(false);
    }
  });

  it('re-asserting the current state is always legal (a no-op, not a transition)', () => {
    for (const state of Object.values(SAP_SYNC_STATE)) {
      expect(isLegalSyncTransition(state, state)).toBe(true);
    }
  });
});

describe('jobs/syncState.js refuses illegal transitions in practice', () => {
  const seedAsn = async (overrides = {}) => runWithTenant('CLT-0001', async () => {
    const po = await prisma.purchaseOrder.create({
      data: { id: `PO-SYNC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, vendorId: 'vendor_sync', status: 'Dispatched' },
    });
    return prisma.aSN.create({
      data: {
        id: `ASN-SYNC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        poId: po.id, vendorId: 'vendor_sync', shipDate: new Date(), estimatedDeliveryDate: new Date(),
        sapSyncState: 'synced', sapDocNumber: 'MIGO-EXISTING', ...overrides,
      },
    });
  });

  it('does not let a stray markPending downgrade an already-synced document', async () => {
    const asn = await seedAsn();

    await runWithTenant('CLT-0001', () => markPending('awaitGoodsReceipt', { asnId: asn.id }));

    const reloaded = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(reloaded.sapSyncState).toBe('synced');
    expect(reloaded.sapDocNumber).toBe('MIGO-EXISTING');
  });

  it('markSynced/markFailed/markOrphaned are all no-ops against an already-synced document', async () => {
    const asn = await seedAsn();

    await runWithTenant('CLT-0001', async () => {
      await markSynced('awaitGoodsReceipt', { asnId: asn.id }, 'MIGO-DIFFERENT');
      await markFailed('awaitGoodsReceipt', { asnId: asn.id }, 'should not apply');
      await markOrphaned('awaitGoodsReceipt', { asnId: asn.id });
    });

    const reloaded = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(reloaded.sapSyncState).toBe('synced');
    expect(reloaded.sapDocNumber).toBe('MIGO-EXISTING');
    expect(reloaded.sapSyncError).toBeNull();
  });

  it('a legal transition (pending -> failed) does apply', async () => {
    const asn = await seedAsn({ sapSyncState: 'pending', sapDocNumber: null });

    await runWithTenant('CLT-0001', () => markFailed('awaitGoodsReceipt', { asnId: asn.id }, 'gateway timeout'));

    const reloaded = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(reloaded.sapSyncState).toBe('failed');
    expect(reloaded.sapSyncError).toBe('gateway timeout');
  });
});

describe('an abandoned job orphans the document it was watching', () => {
  it('exhausting maxAttempts sets the ASN to orphaned with a message', async () => {
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: `PO-ORPH-${Date.now()}`, vendorId: 'vendor_sync', status: 'Dispatched' },
    }));
    const asn = await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: {
        id: `ASN-ORPH-${Date.now()}`, poId: po.id, vendorId: 'vendor_sync',
        shipDate: new Date(), estimatedDeliveryDate: new Date(), sapSyncState: 'pending',
      },
    }));

    const spec = { clientId: 'CLT-0001', kind: 'awaitGoodsReceipt', dedupeKey: `awaitGoodsReceipt:CLT-0001:${asn.id}`, args: { asnId: asn.id, poId: po.id, vendorId: 'vendor_sync' } };
    const enqueued = await enqueue(spec);
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { pk: enqueued.pk }, data: { maxAttempts: 1 } }));
    const [job] = await claim('orphan-test-worker', 1);

    await processJob(job, { handlerFor: () => async () => ({ done: false }) });

    const reloadedAsn = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(reloadedAsn.sapSyncState).toBe('orphaned');
    expect(reloadedAsn.sapSyncError).toMatch(/never answered/);

    const reloadedJob = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk: enqueued.pk } }));
    expect(reloadedJob.status).toBe('abandoned');
  });

  it('exhausting maxAttempts on a thrown error also orphans, with the real error message', async () => {
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: `PO-ORPHERR-${Date.now()}`, vendorId: 'vendor_sync', status: 'Dispatched' },
    }));
    const asn = await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: {
        id: `ASN-ORPHERR-${Date.now()}`, poId: po.id, vendorId: 'vendor_sync',
        shipDate: new Date(), estimatedDeliveryDate: new Date(), sapSyncState: 'pending',
      },
    }));

    const spec = { clientId: 'CLT-0001', kind: 'awaitGoodsReceipt', dedupeKey: `awaitGoodsReceipt:CLT-0001:${asn.id}`, args: { asnId: asn.id, poId: po.id, vendorId: 'vendor_sync' } };
    const enqueued = await enqueue(spec);
    await withoutTenantScope(() => rawPrisma.sapJob.update({ where: { pk: enqueued.pk }, data: { maxAttempts: 1 } }));
    const [job] = await claim('orphan-test-worker-2', 1);

    await processJob(job, { handlerFor: () => async () => { throw new Error('SAP gateway unreachable'); } });

    const reloadedAsn = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(reloadedAsn.sapSyncState).toBe('orphaned');
    expect(reloadedAsn.sapSyncError).toBe('SAP gateway unreachable');
  });

  it('a plain reschedule (not exhausted) leaves the document pending, untouched', async () => {
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: `PO-RESCHED-${Date.now()}`, vendorId: 'vendor_sync', status: 'Dispatched' },
    }));
    const asn = await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: {
        id: `ASN-RESCHED-${Date.now()}`, poId: po.id, vendorId: 'vendor_sync',
        shipDate: new Date(), estimatedDeliveryDate: new Date(), sapSyncState: 'pending',
      },
    }));

    const spec = { clientId: 'CLT-0001', kind: 'awaitGoodsReceipt', dedupeKey: `awaitGoodsReceipt:CLT-0001:${asn.id}`, args: { asnId: asn.id, poId: po.id, vendorId: 'vendor_sync' } };
    const enqueued = await enqueue(spec);
    const [job] = await claim('resched-worker', 1);

    await processJob(job, { handlerFor: () => async () => ({ done: false }) });

    const reloadedAsn = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id } }));
    expect(reloadedAsn.sapSyncState).toBe('pending');
    expect(reloadedAsn.sapSyncError).toBeNull();
  });
});

describe('the backfill migration', () => {
  // Re-runs the exact SQL the migration applied (everything after the
  // "-- Backfill" marker) against freshly seeded rows shaped like
  // pre-migration data, proving the same statements produce the states the
  // plan specifies — not a re-typed copy that could silently drift from what
  // actually ran.
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'migrations', '20260908092510_sap_sync_state', 'migration.sql'),
    'utf8',
  );
  const backfillSql = migrationSql.slice(migrationSql.indexOf('-- Backfill'));
  // Comment lines stripped before splitting on `;` — trying to replay a
  // chunk that is comment-only (nothing but `--` lines between two
  // semicolons) is what broke $executeRawUnsafe here.
  const backfillStatements = backfillSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const runBackfill = () => backfillStatements
    .reduce((chain, statement) => chain.then(() => rawPrisma.$executeRawUnsafe(statement)), Promise.resolve());

  it('produces synced/pending states matching each table\'s existing correlation field', async () => {
    const clientId = 'CLT-0001';
    const suffix = `BF${Date.now()}`;

    const matchedPo = await runWithTenant(clientId, () => prisma.purchaseOrder.create({
      data: { id: `PO-${suffix}-M`, vendorId: 'v', status: 'Delivered', sapPoNumber: '4500009999' },
    }));
    const unmatchedPo = await runWithTenant(clientId, () => prisma.purchaseOrder.create({
      data: { id: `PO-${suffix}-U`, vendorId: 'v', status: 'Dispatched' },
    }));

    await runBackfill();

    const reloadedMatched = await withoutTenantScope(() => rawPrisma.purchaseOrder.findFirst({ where: { pk: matchedPo.pk } }));
    expect(reloadedMatched.sapSyncState).toBe('synced');
    expect(reloadedMatched.sapDocNumber).toBe('4500009999');
    expect(reloadedMatched.sapSyncedAt).not.toBeNull();

    const reloadedUnmatched = await withoutTenantScope(() => rawPrisma.purchaseOrder.findFirst({ where: { pk: unmatchedPo.pk } }));
    expect(reloadedUnmatched.sapSyncState).toBe('pending');
    expect(reloadedUnmatched.sapDocNumber).toBeNull();
  });

  it('never touches RFQ — sourcing stays local by design', async () => {
    const clientId = 'CLT-0001';
    const rfq = await runWithTenant(clientId, () => prisma.rFQ.create({
      data: { id: `RFQ-BF-${Date.now()}`, description: 'x', deadlineDate: new Date() },
    }));

    await runBackfill();

    const reloaded = await withoutTenantScope(() => rawPrisma.rFQ.findFirst({ where: { pk: rfq.pk } }));
    expect(reloaded.sapSyncState).toBe('local');
    expect(reloaded.sapDocNumber).toBeNull();
  });

  it('a Received ASN with a GRN backfills to synced with the GRN\'s document number', async () => {
    const clientId = 'CLT-0001';
    const suffix = `BFG${Date.now()}`;
    const po = await runWithTenant(clientId, () => prisma.purchaseOrder.create({
      data: { id: `PO-${suffix}`, vendorId: 'v', status: 'Delivered' },
    }));
    const asn = await runWithTenant(clientId, () => prisma.aSN.create({
      data: { id: `ASN-${suffix}`, poId: po.id, vendorId: 'v', status: 'Received', shipDate: new Date(), estimatedDeliveryDate: new Date() },
    }));
    await runWithTenant(clientId, () => prisma.gRN.create({
      data: { id: `GRN-${suffix}`, poId: po.id, asnId: asn.id, vendorId: 'v', sapMigoDoc: 'MIGO-BF-1', postingDate: new Date() },
    }));

    await runBackfill();

    const reloaded = await withoutTenantScope(() => rawPrisma.aSN.findFirst({ where: { pk: asn.pk } }));
    expect(reloaded.sapSyncState).toBe('synced');
    expect(reloaded.sapDocNumber).toBe('MIGO-BF-1');
  });

  it('a still-Submitted ASN backfills to pending, not local', async () => {
    const clientId = 'CLT-0001';
    const suffix = `BFS${Date.now()}`;
    const po = await runWithTenant(clientId, () => prisma.purchaseOrder.create({
      data: { id: `PO-${suffix}`, vendorId: 'v', status: 'Dispatched' },
    }));
    const asn = await runWithTenant(clientId, () => prisma.aSN.create({
      data: { id: `ASN-${suffix}`, poId: po.id, vendorId: 'v', status: 'Submitted', shipDate: new Date(), estimatedDeliveryDate: new Date() },
    }));

    await runBackfill();

    const reloaded = await withoutTenantScope(() => rawPrisma.aSN.findFirst({ where: { pk: asn.pk } }));
    expect(reloaded.sapSyncState).toBe('pending');
  });
});

describe('supplier API responses never carry a sapDocNumber for a non-synced document', () => {
  it('formatPo omits nothing dangerous — a pending PO reports its sapDocNumber as null', async () => {
    // The invariant this guards: a number shown to a supplier is either from
    // SAP or clearly marked as not (I5, PROJECT_CONTEXT.md §5.5). sapPoNumber
    // itself already stays null until matched; sapDocNumber must never be the
    // back door that leaks an unmatched value some future call site adds.
    const { formatPo } = require('../db/poHelpers');
    const clientId = 'CLT-0001';
    const po = await runWithTenant(clientId, () => prisma.purchaseOrder.create({
      data: { id: `PO-HONEST-${Date.now()}`, vendorId: 'v', status: 'Dispatched', sapSyncState: 'pending' },
      include: { items: true },
    }));

    const formatted = formatPo(po);
    expect(formatted.sapSyncState).toBe('pending');
    expect(formatted.sapDocNumber).toBeNull();
    expect(formatted.sapPoNumber).toBeNull();
  });
});
