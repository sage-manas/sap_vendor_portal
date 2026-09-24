// Discovery sweeps — Phase 4 of docs/04-sap-runtime-engineering-plan.md.
const request = require('supertest');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const sweepPurchaseOrders = require('../jobs/handlers/sweepPurchaseOrders');
const sweepPayments = require('../jobs/handlers/sweepPayments');
const sweepQuotations = require('../jobs/handlers/sweepQuotations');
const buildTestApp = require('./testApp');
const { seedClient, registerVendor, onboardVendor } = require('./helpers');

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

const runSweep = (clientId, discoveries, extraConfig = {}) => runWithTenant(clientId, () => sweepPurchaseOrders({
  job: { clientId, args: {} },
  adapter: buildTransientAdapter({ clientId, driver: 'mock', config: { discoveries, ...extraConfig }, secrets: {} }),
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

  // Issue #62: a supplier can trade with several company codes in the same
  // SAP client, and the Z endpoint this sweep reads has no company-code
  // filter of its own — it answers everything on the vendor code alone. The
  // tenant declares which company codes are actually theirs
  // (config.companyCodes), and an order outside that set must never be
  // imported, whatever SAP hands back for the same vendor.
  it('imports only the declared company code when a sweep returns two', async () => {
    await seedVendor('CLT-0001', 'vendor_sweep_cc', 'VEN00CC');

    await runSweep(
      'CLT-0001',
      {
        po: [
          discoveryPo('4500098010', { companyCode: '1000' }),
          discoveryPo('4500098011', { companyCode: '2000' }),
        ],
      },
      { companyCodes: '1000' },
    );

    const owned = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { sapPoNumber: '4500098010' } }));
    const outOfScope = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { sapPoNumber: '4500098011' } }));

    expect(owned).toBeTruthy();
    expect(owned.companyCode).toBe('1000');
    expect(outOfScope).toBeNull();
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
    // Status starts at Invoiced and one real line (fully delivered, fully
    // invoiced) so the PO's status is honestly derivable (issue #60) — the
    // only thing this test is watching for is the payment sweep advancing it
    // the rest of the way to Paid.
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-PAYSWEEP-1', vendorId: 'vendor_pay_1', status: 'Invoiced', sapPoNumber: '4500097001', sapDocNumber: '4500097001', sapSyncState: 'synced',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 10, unitPrice: 50, netValue: 500, uom: 'EA' }] },
      },
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
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', quantity: 10, unitPrice: 50, amount: 500 }] },
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

    const payment = await runWithTenant('CLT-0001', () => prisma.payment.findFirst({ where: { items: { some: { invoiceId: invoice.id } } } }));
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

    const payment = await runWithTenant('CLT-0001', () => prisma.payment.findFirst({ where: { items: { some: { poId: po.id } } } }));
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

describe('sweepQuotations discovery — RFQs raised directly in SAP', () => {
  const app = buildTestApp();

  const discoveryRfq = (sapRfqNumber, overrides = {}) => ({
    sapRfqNumber,
    date: '20260923',
    currency: 'INR',
    purchasingOrg: 'SSDN',
    open: true,
    items: [
      { line: 10, materialCode: 'MAT-9210', description: 'Flange 3" ANSI 150#', quantity: 20, uom: 'EA', plant: 'SSDN', type: 'AN' },
    ],
    ...overrides,
  });

  const runQuotationSweep = (clientId, discoveries) => runWithTenant(clientId, () => sweepQuotations({
    job: { clientId, args: {} },
    adapter: buildTransientAdapter({ clientId, driver: 'mock', config: { discoveries }, secrets: {} }),
  }));

  const forceQuotationDue = (clientId, vendorCode) => withoutTenantScope(() => rawPrisma.sapSyncCursor.updateMany({
    where: { clientId, feed: 'quotation', vendorCode },
    data: { lastRunAt: new Date(Date.now() - 24 * 3600 * 1000) },
  }));

  it('creates a local RFQ, with real line items, for one SAP has opened but the portal never raised', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_1', 'VENRFQ1');

    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000901')] });

    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({
      where: { sapDocNumber: '6000000901' }, include: { items: true, invitedVendors: true },
    }));
    expect(rfq).toBeTruthy();
    expect(rfq.status).toBe('Bidding Open');
    expect(rfq.sapSyncState).toBe('synced');
    // No SAP source names a bid-by date — honestly null, not invented.
    expect(rfq.deadlineDate).toBeNull();
    expect(rfq.items).toHaveLength(1);
    expect(rfq.items[0].materialCode).toBe('MAT-9210');
    expect(Number(rfq.items[0].quantity)).toBe(20);
    expect(rfq.invitedVendors.map((v) => v.vendorExtId)).toEqual(['vendor_rfq_1']);
  });

  it('discovers a document already fallen out of ME43 as Closed, not Open', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_2', 'VENRFQ2');

    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000902', { open: false })] });

    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000902' } }));
    expect(rfq.status).toBe('Closed');
  });

  it('closes an already-discovered RFQ once it falls out of the open list, and reopens it if SAP does', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_3', 'VENRFQ3');

    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000903')] }); // open
    let rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000903' } }));
    expect(rfq.status).toBe('Bidding Open');

    await forceQuotationDue('CLT-0001', 'VENRFQ3');
    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000903', { open: false })] });
    rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000903' } }));
    expect(rfq.status).toBe('Closed');

    await forceQuotationDue('CLT-0001', 'VENRFQ3');
    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000903', { open: true })] });
    rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000903' } }));
    expect(rfq.status).toBe('Bidding Open');
  });

  it('never moves an RFQ the portal has already Awarded, even if SAP shows it closed', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_4', 'VENRFQ4');
    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000904')] });
    await runWithTenant('CLT-0001', () => prisma.rFQ.updateMany({
      where: { sapDocNumber: '6000000904' }, data: { status: 'Awarded', awardedVendorId: 'vendor_rfq_4' },
    }));

    await forceQuotationDue('CLT-0001', 'VENRFQ4');
    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000904', { open: false })] });

    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000904' } }));
    expect(rfq.status).toBe('Awarded');
  });

  it('a repeated sweep over identical data creates nothing new (idempotent)', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_5', 'VENRFQ5');
    const discoveries = { rfq: [discoveryRfq('6000000905')] };

    await runQuotationSweep('CLT-0001', discoveries);
    await forceQuotationDue('CLT-0001', 'VENRFQ5');
    await runQuotationSweep('CLT-0001', discoveries);

    const count = await runWithTenant('CLT-0001', () => prisma.rFQ.count({ where: { sapDocNumber: '6000000905' } }));
    expect(count).toBe(1);
  });

  it('a document with no line items on SAP is left undiscovered rather than created empty', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_6', 'VENRFQ6');

    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000906', { items: [] })] });

    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000906' } }));
    expect(rfq).toBeNull();
  });

  // The point of all of the above: once discovered, a supplier can actually
  // bid on it — the same submitBid a portal-created RFQ always accepted,
  // unmodified, including a null deadline never blocking the submission.
  it('a supplier can bid on an RFQ that reached the portal only through discovery', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_rfq_bid_1', gstin: '27AAAAA9010A1Z1' }, { onboarded: true });
    await runWithTenant('CLT-0001', () => prisma.vendor.updateMany({ where: { vendorId: vendor.vendorId }, data: { sapVendorCode: 'VENRFQBID1' } }));

    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000910')] });
    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { sapDocNumber: '6000000910' }, include: { items: true } }));
    expect(rfq.deadlineDate).toBeNull();

    const res = await request(app)
      .post(`/api/rfqs/${rfq.id}/bid`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        unitPrices: { [rfq.items[0].line]: 450 },
        gstRate: '18%',
        freight: 0,
        deliveryLeadTimeDays: 14,
        validityDate: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      });

    expect(res.status).toBe(200);
    const bid = await runWithTenant('CLT-0001', () => prisma.rfqBid.findFirst({ where: { rfqPk: rfq.pk, vendorId: vendor.vendorId } }));
    expect(bid).toBeTruthy();
  });

  // 2026-09-24: before ME43 embedded items, a discovered RFQ's quantity came
  // from vendorRfqDetail's ORDERED_QUANTITY — always 0 for an RFQ, a
  // goods-received field an RFQ has none of. Three real RFQs were stuck at
  // quantity 0 in exactly this way until ME43 started supplying items. A
  // later sweep, once ME43 does have items for that same still-open
  // document, must correct the line already on the RFQ rather than leaving
  // it stuck at whatever that earlier, poorer read recorded.
  it('backfills a discovered RFQ\'s stale quantity once ME43 supplies a real one', async () => {
    await seedVendor('CLT-0001', 'vendor_rfq_7', 'VENRFQ7');

    // Seeds the "before" state directly: an RFQ this sweep already
    // discovered earlier, its one line still carrying the 0 quantity that
    // vendorRfqDetail's fallback would have reported before ME43 embedded
    // items — the precondition under test, not the behaviour being tested.
    const seeded = await runWithTenant('CLT-0001', () => prisma.rFQ.create({
      data: {
        id: 'RFQ-2026-900', clientId: 'CLT-0001', description: 'NEW MATERIAL SAGE TESTING',
        status: 'Bidding Open', rfqType: 'AN', currency: 'INR', purchasingOrg: 'SSDN', companyCode: '1000',
        sapDocNumber: '6000000920', sapSyncState: 'synced',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-9210', description: 'Flange 3" ANSI 150#', quantity: 0, uom: 'EA', plant: 'SSDN' }] },
        invitedVendors: { create: [{ clientId: 'CLT-0001', vendorExtId: 'vendor_rfq_7', name: 'vendor_rfq_7 Pvt Ltd', status: 'Pending' }] },
      },
      include: { items: true },
    }));
    expect(Number(seeded.items[0].quantity)).toBe(0);

    // A sweep where ME43 now supplies this still-open document's real
    // quantity (20, discoveryRfq's default) corrects the existing line.
    await runQuotationSweep('CLT-0001', { rfq: [discoveryRfq('6000000920')] });

    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({
      where: { sapDocNumber: '6000000920' }, include: { items: true },
    }));
    expect(Number(rfq.items[0].quantity)).toBe(20);
    expect(rfq.items).toHaveLength(1); // corrected in place, not duplicated
  });
});
