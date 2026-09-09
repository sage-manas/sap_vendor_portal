// Discovery sweeps — Phase 4 of docs/04-sap-runtime-engineering-plan.md.
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const sweepPurchaseOrders = require('../jobs/handlers/sweepPurchaseOrders');
const sweepPayments = require('../jobs/handlers/sweepPayments');
const { seedClient } = require('./helpers');

const seedVendor = (clientId, vendorId, sapVendorCode) => runWithTenant(clientId, () => prisma.vendor.create({
  data: {
    vendorId, sapVendorCode,
    companyName: `${vendorId} Pvt Ltd`,
    gstin: `27AAAAA${vendorId.slice(-4).padStart(4, '0')}A1Z${vendorId.length % 10}`,
    pan: `AAAAA${vendorId.slice(-4).padStart(4, '0')}A`,
    email: `${vendorId}@example.com`,
  },
}));

const discoveryPo = (sapPoNumber, overrides = {}) => ({
  sapPoNumber,
  buyerName: 'SAP System Procurement',
  currency: 'INR',
  plant: '1000',
  items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' }],
  ...overrides,
});

const runSweep = (clientId, discoveries) => runWithTenant(clientId, () => sweepPurchaseOrders({
  job: { clientId, args: {} },
  adapter: buildTransientAdapter({ clientId, driver: 'mock', config: { discoveries }, secrets: {} }),
}));

describe('sweepPurchaseOrders discovery', () => {
  it('creates a PurchaseOrder for an SAP order the portal never awarded', async () => {
    await seedVendor('CLT-0001', 'vendor_sweep_1', 'VEN0001');

    await runSweep('CLT-0001', { po: [discoveryPo('4500098001')] });

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({
      where: { sapPoNumber: '4500098001' }, include: { items: true },
    }));
    expect(po).toBeTruthy();
    expect(po.sapSyncState).toBe('synced');
    expect(po.sapDocNumber).toBe('4500098001');
    expect(po.vendorId).toBe('vendor_sweep_1');
    expect(po.items).toHaveLength(1);
    expect(po.status).toBe('Open'); // grnQuantity 0 < quantity 10
  });

  it('infers Delivered when SAP already shows every line fully received', async () => {
    await seedVendor('CLT-0001', 'vendor_sweep_2', 'VEN0002');

    await runSweep('CLT-0001', {
      po: [discoveryPo('4500098002', {
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 10, unitPrice: 50, netValue: 500, uom: 'EA' }],
      })],
    });

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { sapPoNumber: '4500098002' } }));
    expect(po.status).toBe('Delivered');
  });

  it('a repeated sweep over identical data creates nothing new (idempotent) and advances quietTicks', async () => {
    await seedVendor('CLT-0001', 'vendor_sweep_3', 'VEN0003');
    const discoveries = { po: [discoveryPo('4500098003')] };
    const cursorKey = { clientId_feed_vendorCode: { clientId: 'CLT-0001', feed: 'po', vendorCode: 'VEN0003' } };

    // Adaptive polling (jobs/adaptivePolling.js, tested on its own in
    // sap-adaptive-polling.test.js) correctly refuses to re-sweep a vendor
    // before its lane's interval has elapsed — which two synchronous calls
    // in a test never do. Backdating lastRunAt between sweeps is what makes
    // "due again" true without waiting real minutes, isolating the
    // fingerprint behaviour under test from that separately-tested gating.
    const forceDue = () => withoutTenantScope(() => rawPrisma.sapSyncCursor.updateMany({
      where: { clientId: 'CLT-0001', feed: 'po', vendorCode: 'VEN0003' },
      data: { lastRunAt: new Date(Date.now() - 24 * 3600 * 1000) },
    }));

    // Sweep 1 discovers and creates the PO — local state itself changes (one
    // more PO now exists to echo back), so its own response necessarily
    // differs from a sweep with nothing local yet. Sweep 2 is where local
    // state first stabilises (the PO already exists both times), so that's
    // the pair a "nothing changed" comparison has to be made across.
    await runSweep('CLT-0001', discoveries);
    await forceDue();
    await runSweep('CLT-0001', discoveries);
    const afterSecond = await withoutTenantScope(() => rawPrisma.sapSyncCursor.findUnique({ where: cursorKey }));

    await forceDue();
    await runSweep('CLT-0001', discoveries);
    const afterThird = await withoutTenantScope(() => rawPrisma.sapSyncCursor.findUnique({ where: cursorKey }));

    const count = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.count({ where: { sapPoNumber: '4500098003' } }));
    expect(count).toBe(1); // no duplicate, across all three sweeps

    expect(afterThird.quietTicks).toBe(afterSecond.quietTicks + 1); // truly nothing changed between sweep 2 and 3
  });

  it('a discovered PO for a vendor with no SAP code is never looked at — nothing is created', async () => {
    await seedVendor('CLT-0001', 'vendor_sweep_nocode', null);

    await runSweep('CLT-0001', { po: [discoveryPo('4500098099')] });

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { sapPoNumber: '4500098099' } }));
    expect(po).toBeNull();
  });

  it('correlates an existing (portal-awarded, not yet synced) PO instead of creating a duplicate', async () => {
    await seedVendor('CLT-0001', 'vendor_sweep_4', 'VEN0004');
    // No discoveries needed here: the mock driver echoes back *any* local PO
    // it's handed (see vendorPoGrnDisplay's own pos.map — this is the same
    // mock-only poId correlation getSapPoStatus's backfill already relies
    // on), so a portal-awarded, unsynced PO alone is enough to exercise the
    // correlate-not-duplicate path.
    await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-SWEEP-EXISTING', vendorId: 'vendor_sweep_4', status: 'Dispatched', sapSyncState: 'pending',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' }] },
      },
    }));

    await runSweep('CLT-0001', {});

    const rows = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findMany({ where: { vendorId: 'vendor_sweep_4' } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('PO-SWEEP-EXISTING');
    expect(rows[0].sapSyncState).toBe('synced');
    expect(rows[0].sapPoNumber).toBeTruthy();
  });

  it('two tenants sweeping the same tick see only their own vendors', async () => {
    await seedClient({ clientId: 'CLT-SWEEP-2', slug: 'sweep-two', companyName: 'Sweep Two' });
    await seedVendor('CLT-0001', 'vendor_sweep_a', 'VEN00A');
    await seedVendor('CLT-SWEEP-2', 'vendor_sweep_b', 'VEN00B');

    await runSweep('CLT-0001', { po: [discoveryPo('4500098010')] });
    await runSweep('CLT-SWEEP-2', { po: [discoveryPo('4500098011')] });

    const tenantAPos = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findMany({ where: {} }));
    const tenantBPos = await runWithTenant('CLT-SWEEP-2', () => prisma.purchaseOrder.findMany({ where: {} }));

    expect(tenantAPos.some((po) => po.sapPoNumber === '4500098010')).toBe(true);
    expect(tenantAPos.some((po) => po.sapPoNumber === '4500098011')).toBe(false);
    expect(tenantBPos.some((po) => po.sapPoNumber === '4500098011')).toBe(true);
    expect(tenantBPos.some((po) => po.sapPoNumber === '4500098010')).toBe(false);
  });
});

describe('sweepPayments discovery', () => {
  const runPaymentSweep = (clientId, discoveries) => runWithTenant(clientId, () => sweepPayments({
    job: { clientId, args: {} },
    adapter: buildTransientAdapter({ clientId, driver: 'mock', config: { discoveries }, secrets: {} }),
  }));

  it('settles an open GRN-matched invoice SAP already shows cleared', async () => {
    await seedVendor('CLT-0001', 'vendor_pay_1', 'VENPAY1');
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: 'PO-PAYSWEEP-1', vendorId: 'vendor_pay_1', status: 'Invoiced', sapPoNumber: '4500097001', sapDocNumber: '4500097001', sapSyncState: 'synced' },
    }));
    const asn = await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: { id: 'ASN-PAYSWEEP-1', poId: po.id, vendorId: 'vendor_pay_1', status: 'Received', shipDate: new Date(), estimatedDeliveryDate: new Date() },
    }));
    const grn = await runWithTenant('CLT-0001', () => prisma.gRN.create({
      data: { id: 'GRN-PAYSWEEP-1', poId: po.id, asnId: asn.id, vendorId: 'vendor_pay_1', postingDate: new Date() },
    }));
    // grnId (not invoicePlanRef) is what makes this a GRN-matched invoice —
    // the two are mutually exclusive at the database level.
    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-PAYSWEEP-1', grnId: grn.id, poId: po.id, vendorId: 'vendor_pay_1', invoiceNumber: 'INV-1',
        invoiceDate: new Date(), status: 'Submitted', subTotal: 500, taxAmount: 90, totalAmount: 590,
      },
    }));

    await runPaymentSweep('CLT-0001', {
      payment: [{
        poId: po.sapPoNumber, sapMiroDoc: 'MIRO-SWEEP-1', grossAmount: 590, tdsDeducted: 5.9, netAmount: 584.1,
        paymentDate: new Date(), sapPaymentDoc: 'PAY-SWEEP-1', paymentMethod: 'NEFT', utrCode: 'UTR-SWEEP-1',
      }],
    });

    const reloadedInvoice = await runWithTenant('CLT-0001', () => prisma.invoice.findFirst({ where: { pk: invoice.pk } }));
    expect(reloadedInvoice.status).toBe('Cleared');
    expect(reloadedInvoice.sapSyncState).toBe('synced');

    const payment = await runWithTenant('CLT-0001', () => prisma.payment.findFirst({ where: { invoiceId: invoice.id } }));
    expect(payment).toBeTruthy();
    expect(payment.sapPaymentDoc).toBe('PAY-SWEEP-1');

    const reloadedPo = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { pk: po.pk } }));
    expect(reloadedPo.status).toBe('Paid');
  });

  it('never touches a plan-based invoice (invoicePlanRef set)', async () => {
    await seedVendor('CLT-0001', 'vendor_pay_2', 'VENPAY2');
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: 'PO-PAYSWEEP-2', vendorId: 'vendor_pay_2', status: 'Open', sapPoNumber: '4500097002', sapDocNumber: '4500097002', sapSyncState: 'synced' },
    }));
    await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-PAYSWEEP-2', poId: po.id, vendorId: 'vendor_pay_2', invoiceNumber: 'INV-2',
        invoiceDate: new Date(), status: 'Submitted', subTotal: 500, taxAmount: 90, totalAmount: 590,
        invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Partial', settlementDate: new Date().toISOString() },
      },
    }));

    await runPaymentSweep('CLT-0001', {
      payment: [{ poId: po.sapPoNumber, grossAmount: 590, netAmount: 584, paymentDate: new Date(), sapPaymentDoc: 'PAY-SWEEP-2' }],
    });

    const payment = await runWithTenant('CLT-0001', () => prisma.payment.findFirst({ where: { poId: po.id } }));
    expect(payment).toBeNull();
  });

  it('does nothing for a PO the portal has no record of at all', async () => {
    await seedVendor('CLT-0001', 'vendor_pay_3', 'VENPAY3');

    await expect(runPaymentSweep('CLT-0001', {
      payment: [{ poId: '4500097999', grossAmount: 100, netAmount: 99, paymentDate: new Date(), sapPaymentDoc: 'PAY-SWEEP-3' }],
    })).resolves.toEqual({ done: true });

    const payment = await runWithTenant('CLT-0001', () => prisma.payment.findFirst({ where: { sapPaymentDoc: 'PAY-SWEEP-3' } }));
    expect(payment).toBeNull();
  });
});
