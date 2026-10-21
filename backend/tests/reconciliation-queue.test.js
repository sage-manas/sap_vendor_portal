// The reconciliation queue — Phase 3 of docs/04-sap-runtime-engineering-plan.md.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { enqueue } = require('../jobs/queue');
const { createOperatorSession, seedClient } = require('./helpers');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const makeAsn = async (clientId, overrides = {}) => runWithTenant(clientId, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const po = await prisma.purchaseOrder.create({
    data: { id: `PO-RQ-${suffix}`, vendorId: 'vendor_rq', status: 'Dispatched' },
  });
  return prisma.aSN.create({
    data: {
      id: `ASN-RQ-${suffix}`, poId: po.id, vendorId: 'vendor_rq',
      shipDate: new Date(), estimatedDeliveryDate: new Date(),
      ...overrides,
    },
  });
});

const makeInvoice = async (clientId, overrides = {}) => runWithTenant(clientId, async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const po = await prisma.purchaseOrder.create({
    data: { id: `PO-RQ-${suffix}`, vendorId: 'vendor_rq', status: 'Invoiced' },
  });
  return prisma.invoice.create({
    data: {
      id: `INV-RQ-${suffix}`, poId: po.id, vendorId: 'vendor_rq', invoiceNumber: `V-${suffix}`,
      invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118,
      // grnId and invoicePlanRef are mutually exclusive but exactly one is
      // required (a CHECK constraint) — this test has no need for a full
      // ASN→GRN chain, so it's the invoicing-plan shape, same as
      // tds-summary.test.js.
      invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
      ...overrides,
    },
  });
});

describe('GET /platform/reconciliation', () => {
  it('lists a failed row and an orphaned row, but not a synced or local one', async () => {
    const { token } = await createOperatorSession();

    const failedAsn = await makeAsn('CLT-0001', { sapSyncState: 'failed', sapSyncError: 'gateway down' });
    const orphanedAsn = await makeAsn('CLT-0001', { sapSyncState: 'orphaned', sapSyncError: 'never answered' });
    const syncedAsn = await makeAsn('CLT-0001', { sapSyncState: 'synced', sapDocNumber: 'MIGO-1' });
    const localAsn = await makeAsn('CLT-0001', { sapSyncState: 'local' });

    const res = await request(app).get('/api/platform/reconciliation?type=ASN').set(bearer(token));

    expect(res.status).toBe(200);
    const ids = res.body.rows.map((r) => r.id);
    expect(ids).toContain(failedAsn.id);
    expect(ids).toContain(orphanedAsn.id);
    expect(ids).not.toContain(syncedAsn.id);
    expect(ids).not.toContain(localAsn.id);
  });

  it('includes a pending row only once it is past the SLA', async () => {
    const { token } = await createOperatorSession();

    const freshAsn = await makeAsn('CLT-0001', { sapSyncState: 'pending' });
    const staleAsn = await makeAsn('CLT-0001', { sapSyncState: 'pending' });
    // Backdate updatedAt directly — Prisma's @updatedAt would otherwise stamp "now".
    await withoutTenantScope(() => rawPrisma.aSN.update({
      where: { pk: staleAsn.pk },
      data: { updatedAt: new Date(Date.now() - 10 * 3600 * 1000) },
    }));

    const res = await request(app).get('/api/platform/reconciliation?type=ASN').set(bearer(token));

    const ids = res.body.rows.map((r) => r.id);
    expect(ids).not.toContain(freshAsn.id);
    expect(ids).toContain(staleAsn.id);
  });

  it('filters by tenant', async () => {
    const { token } = await createOperatorSession();
    await seedClient({ clientId: 'CLT-RQ-2', slug: 'rq-two', companyName: 'RQ Two' });

    const ownAsn = await makeAsn('CLT-0001', { sapSyncState: 'failed', sapSyncError: 'x' });
    const otherAsn = await makeAsn('CLT-RQ-2', { sapSyncState: 'failed', sapSyncError: 'x' });

    const res = await request(app).get('/api/platform/reconciliation?type=ASN&clientId=CLT-0001').set(bearer(token));

    const ids = res.body.rows.map((r) => r.id);
    expect(ids).toContain(ownAsn.id);
    expect(ids).not.toContain(otherAsn.id);
  });

  it('requires platform:health:read', async () => {
    const res = await request(app).get('/api/platform/reconciliation');
    expect(res.status).toBe(401);
  });

  // Issue #64: an ambiguous SAP match (a periodic invoicing plan's
  // same-amount siblings, most commonly) parks an invoice in
  // needs_manual_match. A retry alone never resolves it, so — unlike a
  // merely-slow `pending` row — it must show up immediately, not after
  // waiting out the SLA window, and with both candidate documents named.
  it('lists a needs_manual_match invoice immediately, with both candidates named', async () => {
    const { token } = await createOperatorSession();

    const freshInvoice = await makeInvoice('CLT-0001', {
      sapSyncState: 'needs_manual_match',
      sapSyncError: 'Ambiguous match: 2 SAP documents fit PO 4500012345 / amount 50000 (5100000001, 5100000002) — needs manual resolution.',
    });

    const res = await request(app).get('/api/platform/reconciliation?type=Invoice').set(bearer(token));

    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.id === freshInvoice.id);
    expect(row).toBeTruthy();
    expect(row.sapSyncState).toBe('needs_manual_match');
    expect(row.sapSyncError).toContain('5100000001');
    expect(row.sapSyncError).toContain('5100000002');
  });

  // Issue #286: the per-type LIMIT used to be applied before the `state`
  // filter (which ran in JS afterwards), so a type holding more than a page
  // of older pending-past-SLA rows hid its own failed ones entirely, and
  // `total` reported the capped page instead of the real backlog.
  describe('with more than one page of rows for a type', () => {
    const BULK_TENANT = 'CLT-RQ-286';
    const PENDING_COUNT = 250;
    const FAILED_COUNT = 3;
    let token;

    // The database is reset after every test (tests/setup.js), so the bulk
    // fixture is rebuilt per test rather than once — 253 rows in two
    // createMany calls, not 253 round trips.
    beforeEach(async () => {
      ({ token } = await createOperatorSession());
      await seedClient({ clientId: BULK_TENANT, slug: 'rq-286', companyName: 'RQ Bulk' });

      await runWithTenant(BULK_TENANT, async () => {
        const po = await prisma.purchaseOrder.create({
          data: { id: 'PO-RQ286', vendorId: 'vendor_rq', status: 'Dispatched' },
        });
        const asn = (n, state) => ({
          clientId: BULK_TENANT,
          id: `ASN-RQ286-${state}-${n}`,
          poId: po.id,
          vendorId: 'vendor_rq',
          shipDate: new Date(),
          estimatedDeliveryDate: new Date(),
          sapSyncState: state,
        });
        await prisma.aSN.createMany({
          data: [
            ...Array.from({ length: PENDING_COUNT }, (_, n) => asn(n, 'pending')),
            ...Array.from({ length: FAILED_COUNT }, (_, n) => asn(n, 'failed')),
          ],
        });
      });

      // Backdate every pending row past the SLA, and make the failed rows the
      // newest in the table — so under the old code they sorted past the
      // per-type LIMIT and vanished from `?state=failed`.
      await withoutTenantScope(() => rawPrisma.$executeRawUnsafe(
        `UPDATE "asns" SET "updatedAt" = NOW() - INTERVAL '10 hours'
         WHERE "clientId" = $1 AND "sapSyncState" = 'pending'`,
        BULK_TENANT,
      ));
    });

    it('returns the true total, not the size of the capped page', async () => {
      const res = await request(app)
        .get(`/api/platform/reconciliation?type=ASN&clientId=${BULK_TENANT}`)
        .set(bearer(token));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(PENDING_COUNT + FAILED_COUNT);
      expect(res.body.byType.ASN).toBe(PENDING_COUNT + FAILED_COUNT);
      expect(res.body.rows).toHaveLength(res.body.pageSize);
    });

    it('finds the failed rows behind a page of pending ones', async () => {
      const res = await request(app)
        .get(`/api/platform/reconciliation?type=ASN&clientId=${BULK_TENANT}&state=failed`)
        .set(bearer(token));

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(FAILED_COUNT);
      expect(res.body.rows).toHaveLength(FAILED_COUNT);
      expect(res.body.rows.every((r) => r.sapSyncState === 'failed')).toBe(true);
      expect(res.body.nextCursor).toBeNull();
    });

    it('pages the rest of the backlog through nextCursor without repeating a row', async () => {
      const url = `/api/platform/reconciliation?type=ASN&clientId=${BULK_TENANT}`;
      const first = await request(app).get(url).set(bearer(token));
      expect(first.body.nextCursor).toBeTruthy();

      const second = await request(app)
        .get(`${url}&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set(bearer(token));

      expect(second.status).toBe(200);
      expect(second.body.total).toBe(PENDING_COUNT + FAILED_COUNT);
      const pks = [...first.body.rows, ...second.body.rows].map((r) => r.pk);
      expect(new Set(pks).size).toBe(pks.length);
      expect(pks).toHaveLength(PENDING_COUNT + FAILED_COUNT);
    });

    it('rejects a state outside the queue, and a malformed cursor', async () => {
      const synced = await request(app)
        .get('/api/platform/reconciliation?state=synced').set(bearer(token));
      expect(synced.status).toBe(400);

      const bogus = await request(app)
        .get('/api/platform/reconciliation?cursor=not-a-cursor').set(bearer(token));
      expect(bogus.status).toBe(400);
    });
  });
});

describe('POST /platform/reconciliation/:type/:pk/retry', () => {
  it('resets the job watching an ASN and moves it back to pending', async () => {
    const { token } = await createOperatorSession();
    const asn = await makeAsn('CLT-0001', { sapSyncState: 'orphaned', sapSyncError: 'never answered' });

    const job = await enqueue({
      clientId: 'CLT-0001', kind: 'awaitGoodsReceipt',
      dedupeKey: `awaitGoodsReceipt:CLT-0001:${asn.id}`,
      args: { asnId: asn.id, poId: asn.poId, vendorId: 'vendor_rq' },
    });
    await withoutTenantScope(() => rawPrisma.sapJob.update({
      where: { pk: job.pk }, data: { status: 'abandoned', attempts: 5, lastError: 'never answered' },
    }));

    const res = await request(app)
      .post(`/api/platform/reconciliation/ASN/${asn.pk}/retry`)
      .set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe('pending');
    expect(res.body.job.attempts).toBe(0);

    const reloadedAsn = await runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { pk: asn.pk } }));
    expect(reloadedAsn.sapSyncState).toBe('pending');
  });

  it('refuses to retry a PurchaseOrder — it has no watching job', async () => {
    const { token } = await createOperatorSession();
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: `PO-RQNORETRY-${Date.now()}`, vendorId: 'v', status: 'Dispatched', sapSyncState: 'pending' },
    }));

    const res = await request(app)
      .post(`/api/platform/reconciliation/PurchaseOrder/${po.pk}/retry`)
      .set(bearer(token));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no watching job/);
  });

  it('404s an unknown pk', async () => {
    const { token } = await createOperatorSession();
    const res = await request(app)
      .post('/api/platform/reconciliation/ASN/00000000-0000-0000-0000-000000000000/retry')
      .set(bearer(token));
    expect(res.status).toBe(400);
  });
});
