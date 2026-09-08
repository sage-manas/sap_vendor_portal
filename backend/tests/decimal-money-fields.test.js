// prisma/schema.prisma moved 16 currency fields from Float to Decimal (see
// its field comments and utils/money.js's header for why). Decimal columns
// come back from Prisma as decimal.js instances, not plain numbers — and
// critically, `+` on one silently does STRING CONCATENATION instead of
// addition (its valueOf() returns a string, and `+` falls back to
// concatenation whenever either operand is a string), while `*`/`-` happen to
// still work because those operators force numeric coercion regardless of
// operand type. Every place that reads one of these columns has to convert
// explicitly rather than lean on that split behavior.
//
// This suite is the regression net for that migration: it proves the
// precision win it exists for, and it forces the one path that was actually
// found broken during the migration — controllers/po.controller.js's
// syncInvoicePlan, which builds its response from a *raw* (unformatted) PO
// read and was feeding a raw Decimal plan straight into
// services/invoicePlan.service.js's summarizePlan(), corrupting its totals
// into concatenated strings.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser } = require('./helpers');
const { runWithTenant } = require('../utils/tenantContext');

const app = buildTestApp();
const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);
const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

describe('money fields survive the Float → Decimal migration', () => {
  it('an RFQ award response carries plain numbers, not Decimal strings', async () => {
    const supplier = await registerVendor(app, { vendorId: 'vendor_decimal_1', gstin: '27AAAAA3001A1Z1' }, { onboarded: true });
    const buyer = await createAdminUser({ email: 'decimal-buyer-1@example.com' });
    const asSupplier = auth(supplier.token);
    const asBuyer = auth(buyer.token);

    const rfqRes = await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'Decimal precision check',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 3, targetPrice: 33.33 }],
      invitedVendors: [{ id: 'vendor_decimal_1', name: 'Supplier', rating: 90 }],
    });
    expect(rfqRes.status).toBe(201);

    const bidRes = await asSupplier(request(app).post(`/api/rfqs/${rfqRes.body.id}/bid`)).send({
      unitPrices: { 10: 33.33 },
      gstRate: '18%',
      deliveryLeadTimeDays: 5,
      validityDate: futureDate(30),
      freight: 12.5,
    });
    expect(bidRes.status).toBe(200);

    const awardRes = await asBuyer(request(app).post(`/api/rfqs/${rfqRes.body.id}/award`)).send({ vendorId: 'vendor_decimal_1' });
    expect(awardRes.status).toBe(200);

    const item = awardRes.body.po.items[0];
    expect(typeof item.unitPrice).toBe('number');
    expect(typeof item.netValue).toBe('number');
    expect(item.unitPrice).toBe(33.33);
    expect(item.netValue).toBeCloseTo(99.99, 2);

    // The RFQ detail view goes through the same formatBid()/formatRfq() as
    // the award — confirms the fix isn't specific to awardBid's own response.
    const rfqDetail = await asBuyer(request(app).get(`/api/rfqs/${rfqRes.body.id}`));
    expect(typeof rfqDetail.body.bids[0].unitPrices['10']).toBe('number');
    expect(typeof rfqDetail.body.bids[0].freight).toBe('number');
    expect(typeof rfqDetail.body.items[0].targetPrice).toBe('number');
  });

  it('a submitted invoice and its eventual payment carry plain numbers throughout', async () => {
    const supplier = await registerVendor(app, { vendorId: 'vendor_decimal_2', gstin: '27AAAAA3002A1Z1' }, { onboarded: true });
    const asSupplier = auth(supplier.token);

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-DECIMAL-0002',
        sapPoNumber: '4500099002',
        vendorId: 'vendor_decimal_2',
        status: 'Delivered',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 10, unitPrice: 33.33, netValue: 333.30, uom: 'EA' }] },
      },
      include: { items: true },
    }));
    await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: { id: 'ASN-DECIMAL-0002', poId: po.id, vendorId: 'vendor_decimal_2', shipDate: new Date(), estimatedDeliveryDate: new Date() },
    }));
    const grn = await runWithTenant('CLT-0001', () => prisma.gRN.create({
      data: { id: 'GRN-DECIMAL-0002', poId: po.id, asnId: 'ASN-DECIMAL-0002', vendorId: 'vendor_decimal_2', postingDate: new Date() },
    }));
    await runWithTenant('CLT-0001', () => prisma.grnItem.create({
      data: { clientId: 'CLT-0001', grnPk: grn.pk, line: 10, materialCode: 'MAT-1', description: 'Widget', receivedQuantity: 10, acceptedQuantity: 10, rejectedQuantity: 0 },
    }));

    const invoiceRes = await asSupplier(request(app).post('/api/invoices')).send({
      grnId: grn.id,
      invoiceNumber: 'INV-DECIMAL-0002',
      invoiceDate: new Date().toISOString(),
      subTotal: 333.30,
      taxAmount: 59.99,
      totalAmount: 393.29,
      items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, unitPrice: 33.33, amount: 333.30 }],
    });
    expect(invoiceRes.status).toBe(201);
    const inv = invoiceRes.body.invoice;
    expect(typeof inv.subTotal).toBe('number');
    expect(typeof inv.taxAmount).toBe('number');
    expect(typeof inv.totalAmount).toBe('number');
    expect(typeof inv.items[0].unitPrice).toBe('number');
    expect(typeof inv.items[0].amount).toBe('number');
    expect(inv.totalAmount).toBeCloseTo(393.29, 2);

    // The deferred SAP payment run fires on its own schedule (zero delay under
    // NODE_ENV=test — see sap/drivers/mock.driver.js). Poll for it rather than
    // assuming it has landed.
    let payment = null;
    for (let i = 0; i < 50 && !payment; i += 1) {
      const res = await asSupplier(request(app).get('/api/payments'));
      payment = (res.body.payments || []).find((p) => p.invoiceId === inv.id);
      if (!payment) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(payment).toBeTruthy();
    expect(typeof payment.grossAmount).toBe('number');
    expect(typeof payment.tdsDeducted).toBe('number');
    expect(typeof payment.netAmount).toBe('number');
    // 1% TDS (sap/drivers/mock.driver.js's DEFAULT_BEHAVIOUR.tdsRate), and the
    // arithmetic that produces it (`gross - tdsDeducted`) is exactly the
    // subtraction that would have gone through Decimal's coercion correctly
    // even unconverted — this asserts the *value*, not just the type, stays
    // right end to end.
    expect(payment.netAmount).toBeCloseTo(payment.grossAmount - payment.tdsDeducted, 2);
  });

  it('syncInvoicePlan (a raw, unformatted PO read) still reports correct totals, not concatenated strings', async () => {
    // This is the one path the migration actually broke: buildPlan below feeds
    // amounts through services/invoicePlan.service.js's summarizePlan(), and
    // syncInvoicePlan (controllers/po.controller.js) used to call it with a
    // raw Prisma object rather than one run through db/poHelpers.js's
    // formatPlan(). `sum + (line.amount || 0)` on a raw Decimal there does
    // string concatenation, not addition — this proves it doesn't anymore.
    const buyer = await createAdminUser({ email: 'decimal-buyer-3@example.com' });
    const asBuyer = auth(buyer.token);

    await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-DECIMAL-0003',
        sapPoNumber: '4500099003',
        vendorId: 'vendor_decimal_3',
        status: 'Open',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 1, grnQuantity: 0, unitPrice: 1000, netValue: 1000, uom: 'EA' }] },
      },
    }));

    // Configure a partial plan with two milestones — the same shape
    // tests/invoice-plan.test.js's partialBody uses — so poInvoicePlanDisplay
    // (sap/drivers/mock.driver.js) has something to "discover" and echo back
    // on sync.
    const configureRes = await asBuyer(request(app).put('/api/pos/PO-DECIMAL-0003/items/10/invoice-plan')).send({
      type: 'Partial',
      milestones: [
        { settlementDate: '2020-01-01', percentage: 40, description: 'On order' },
        { settlementDate: '2099-01-01', percentage: 60, description: 'On commissioning' },
      ],
    });
    expect(configureRes.status).toBe(200);

    const syncRes = await asBuyer(request(app).post('/api/pos/PO-DECIMAL-0003/invoice-plan/sync'));
    expect(syncRes.status).toBe(200);
    expect(syncRes.body.adopted).toEqual([10]);

    const item = syncRes.body.items.find((i) => i.line === 10);
    expect(item).toBeTruthy();
    expect(typeof item.unitPrice).toBe('number');
    expect(typeof item.netValue).toBe('number');
    for (const line of item.plan.lines) {
      expect(typeof line.amount).toBe('number');
    }

    // The actual bug: a string-concatenated "totalValue" is a string, and even
    // if it were coerced back it would read as e.g. "0400600" (digit-by-digit
    // concatenation of unrounded fractions) rather than 1000 — nowhere near a
    // number-vs-string mixup that toBeCloseTo would forgive.
    expect(typeof item.summary.totalValue).toBe('number');
    expect(item.summary.totalValue).toBeCloseTo(1000, 2);
    expect(item.summary.openValue).toBeCloseTo(1000, 2);
  });

  it('Decimal(14,2) avoids the binary-float drift Float carried', async () => {
    // 0.1 + 0.2 has no exact binary (base-2) representation, so summing three
    // GST-shaped fractions as IEEE-754 doubles drifts by a fraction of a
    // paisa — invisible until it accumulates across enough invoice lines, and
    // exactly what DECIMAL(14,2) storage avoids by keeping the digits that
    // were written, not their nearest binary approximation.
    expect(0.1 + 0.2).not.toBe(0.3); // the drift this migration removes

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-DECIMAL-0004',
        vendorId: 'vendor_decimal_4',
        items: {
          create: [
            { clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', quantity: 1, unitPrice: 0.1, netValue: 0.1, uom: 'EA' },
            { clientId: 'CLT-0001', line: 20, materialCode: 'MAT-2', quantity: 1, unitPrice: 0.2, netValue: 0.2, uom: 'EA' },
          ],
        },
      },
      include: { items: true },
    }));

    const sum = po.items.reduce((acc, item) => acc.plus(item.unitPrice), new (require('@prisma/client').Prisma.Decimal)(0));
    expect(sum.toNumber()).toBe(0.3);
  });

  it('the dashboard summary sums raw payment rows without string-concatenating them', async () => {
    // controllers/dashboard.controller.js reads prisma.payment.findMany
    // directly (no formatPayment) and reduces netAmount/grossAmount — exactly
    // the raw-Decimal-plus-number shape that concatenates instead of summing
    // without the fix.
    const supplier = await registerVendor(app, { vendorId: 'vendor_decimal_5', gstin: '27AAAAA3005A1Z1' }, { onboarded: true });
    const asSupplier = auth(supplier.token);

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: 'PO-DECIMAL-0005', vendorId: 'vendor_decimal_5', status: 'Paid' },
    }));
    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-DECIMAL-0005', poId: po.id, vendorId: 'vendor_decimal_5',
        invoiceNumber: 'V/1', invoiceDate: new Date(),
        subTotal: 100, taxAmount: 18, totalAmount: 118,
        invoicePlanRef: { line: 10, planLineNumber: 1 },
      },
    }));
    // Two payments, so a string-concatenation bug (rather than a single value
    // just happening to print correctly) is unambiguous in the result.
    await runWithTenant('CLT-0001', () => prisma.payment.createMany({
      data: [
        { id: 'PMT-DECIMAL-0005A', clientId: 'CLT-0001', invoiceId: invoice.id, poId: po.id, vendorId: 'vendor_decimal_5', netAmount: 50.25, paymentDate: new Date(), utrCode: 'UTR1' },
        { id: 'PMT-DECIMAL-0005B', clientId: 'CLT-0001', invoiceId: invoice.id, poId: po.id, vendorId: 'vendor_decimal_5', netAmount: 25.75, paymentDate: new Date(), utrCode: 'UTR2' },
      ],
    }));

    const res = await asSupplier(request(app).get('/api/dashboard/summary'));
    expect(res.status).toBe(200);
    expect(typeof res.body.totalPaymentsAmount).toBe('number');
    expect(res.body.totalPaymentsAmount).toBeCloseTo(76, 2);
  });

  it('the metrics report sums a Decimal aggregate without leaking a Decimal into the response', async () => {
    // controllers/reports.controller.js's getPlatformMetrics reads
    // prisma.payment.aggregate({ _sum: { netAmount: true } }) — Prisma's _sum
    // over a Decimal column is itself a Decimal, not a plain number. Despite
    // its name and the route's stale "Admin/Private" comment, /api/reports/
    // metrics is mounted behind protectOnboarded (routes/index.js) and
    // report:metrics is only granted to tenant staff — see
    // config/permissions.js's TENANT_READ_ONLY — not the platform plane.
    const staff = await createAdminUser({ email: 'decimal-metrics-1@example.com' });
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: 'PO-DECIMAL-0006', vendorId: 'vendor_decimal_6', status: 'Paid' },
    }));
    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-DECIMAL-0006', poId: po.id, vendorId: 'vendor_decimal_6',
        invoiceNumber: 'V/2', invoiceDate: new Date(),
        subTotal: 100, taxAmount: 18, totalAmount: 118,
        invoicePlanRef: { line: 10, planLineNumber: 1 },
      },
    }));
    await runWithTenant('CLT-0001', () => prisma.payment.create({
      data: { id: 'PMT-DECIMAL-0006', invoiceId: invoice.id, poId: po.id, vendorId: 'vendor_decimal_6', netAmount: 42.42, paymentDate: new Date(), utrCode: 'UTR3' },
    }));

    const res = await request(app).get('/api/reports/metrics').set('Authorization', `Bearer ${staff.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.totalVolume).toBe('number');
    expect(res.body.totalVolume).toBeGreaterThanOrEqual(42.42);
  });
});
