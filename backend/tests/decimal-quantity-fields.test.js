// prisma/schema.prisma moved 8 quantity fields from Float to Decimal(13,3),
// matching SAP's own MENGE (issue #65) — see utils/quantity.js's header for
// why, and utils/money.js's for the general Decimal-vs-Float trap this is
// the same fix for. This suite is the regression net for that migration,
// modelled on tests/decimal-money-fields.test.js.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createAdminUser, runDueJobs } = require('./helpers');
const { enqueue } = require('../jobs/queue');

const app = buildTestApp();
const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);
const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const until = async (probe, what, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    await runDueJobs();
    const answer = await probe();
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe('quantity fields survive the Float → Decimal migration', () => {
  it('an RFQ award response carries plain quantity numbers, not Decimal strings', async () => {
    const supplier = await registerVendor(app, { vendorId: 'vendor_qty_1', gstin: '27AAAAA4001A1Z1' }, { onboarded: true });
    const buyer = await createAdminUser({ email: 'qty-buyer-1@example.com' });
    const asSupplier = auth(supplier.token);
    const asBuyer = auth(buyer.token);

    const rfqRes = await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'Quantity precision check',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 3.5, targetPrice: 10 }],
      invitedVendors: [{ id: 'vendor_qty_1', name: 'Supplier', rating: 90 }],
    });
    expect(rfqRes.status).toBe(201);
    expect(typeof rfqRes.body.items[0].quantity).toBe('number');
    expect(rfqRes.body.items[0].quantity).toBe(3.5);

    const bidRes = await asSupplier(request(app).post(`/api/rfqs/${rfqRes.body.id}/bid`)).send({
      unitPrices: { 10: 10 }, gstRate: '18%', deliveryLeadTimeDays: 5, validityDate: futureDate(30), freight: 0,
    });
    expect(bidRes.status).toBe(200);

    const awardRes = await asBuyer(request(app).post(`/api/rfqs/${rfqRes.body.id}/award`)).send({ vendorId: 'vendor_qty_1' });
    expect(awardRes.status).toBe(200);

    const item = awardRes.body.po.items[0];
    expect(typeof item.quantity).toBe('number');
    expect(typeof item.grnQuantity).toBe('number');
    expect(item.quantity).toBe(3.5);
    expect(item.grnQuantity).toBe(0);
  });

  it('a GRN read back carries plain quantity numbers and correct totals', async () => {
    const supplier = await registerVendor(app, { vendorId: 'vendor_qty_2', gstin: '27AAAAA4002A1Z1' }, { onboarded: true });
    const buyer = await createAdminUser({ email: 'qty-buyer-2@example.com' });
    const asSupplier = auth(supplier.token);
    const asBuyer = auth(buyer.token);

    const rfqRes = await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'GRN quantity check',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, targetPrice: 10 }],
      invitedVendors: [{ id: 'vendor_qty_2', name: 'Supplier', rating: 90 }],
    });
    const bidRes = await asSupplier(request(app).post(`/api/rfqs/${rfqRes.body.id}/bid`)).send({
      unitPrices: { 10: 10 }, gstRate: '18%', deliveryLeadTimeDays: 5, validityDate: futureDate(30), freight: 0,
    });
    expect(bidRes.status).toBe(200);
    const awardRes = await asBuyer(request(app).post(`/api/rfqs/${rfqRes.body.id}/award`)).send({ vendorId: 'vendor_qty_2' });
    const poId = awardRes.body.po.id;
    await asSupplier(request(app).put(`/api/pos/${poId}/acknowledge`));

    await asSupplier(request(app).post(`/api/pos/${poId}/asn`)).send({
      shipDate: new Date().toISOString(), estimatedDeliveryDate: futureDate(2),
      items: [{ line: 10, shippedQuantity: 10 }],
    });

    const grn = await until(async () => {
      const res = await asSupplier(request(app).get('/api/grns'));
      return (res.body.grns || res.body || []).find((g) => g.poId === poId);
    }, `a goods receipt for ${poId}`);

    const item = grn.items[0];
    expect(typeof item.receivedQuantity).toBe('number');
    expect(typeof item.acceptedQuantity).toBe('number');
    expect(typeof item.rejectedQuantity).toBe('number');
    expect(typeof grn.totalAccepted).toBe('number');
    expect(item.receivedQuantity).toBeCloseTo(item.acceptedQuantity + item.rejectedQuantity, 3);
  });

  // The acceptance test issue #65 names explicitly: partial receipts whose
  // Float sum would land on 0.9999999999999999 instead of 1 must still mark
  // the line fully received. Three separate GRNs against the same PO line,
  // each accepting a fraction a binary float cannot represent exactly — 0.1,
  // 0.2, 0.7 — accumulated onto PurchaseOrderItem.grnQuantity the same way
  // jobs/handlers/awaitGoodsReceipt.js's `grnQuantity + acceptedQuantity`
  // does in production for a real multi-shipment order.
  //
  // Seeded with three ASN rows directly rather than three calls to
  // POST /pos/:id/asn: submitASN refuses a second shipment once the PO has
  // left `Acknowledged` (controllers/po.controller.js), which the first
  // GRN's own derived status (issue #60) always moves it past — a real,
  // separate business rule this test has no reason to fight to exercise the
  // accumulation arithmetic. Three ASNs against one PO line is exactly the
  // shape a partially-delivered order already has in this schema regardless
  // of which endpoint created them.
  it('three partial receipts summing exactly to the ordered quantity mark the line fully received', async () => {
    // mock.driver.js's awaitGoodsReceipt rejects a share of what's shipped by
    // default (grnAcceptanceRate 0.95) — pinned to 1.0 here so the accepted
    // total is exactly what this test needs to land on the 0.1+0.2+0.7
    // boundary, not a moving target against a randomised inspection rate.
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 'mock', config: { behaviour: { grnAcceptanceRate: 1 } } },
    }));

    const vendorId = 'vendor_qty_3';
    await registerVendor(app, { vendorId, gstin: '27AAAAA4003A1Z1' }, { onboarded: true });
    const buyer = await createAdminUser({ email: 'qty-buyer-3@example.com' });
    const asBuyer = auth(buyer.token);

    const { po, asns } = await runWithTenant('CLT-0001', async () => {
      const created = await prisma.purchaseOrder.create({
        data: {
          id: 'PO-QTY-PARTIAL', vendorId, status: 'Acknowledged', acknowledgedAt: new Date(),
          items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 1, grnQuantity: 0, unitPrice: 100, netValue: 100, uom: 'EA' }] },
        },
        include: { items: true },
      });

      const shipments = await Promise.all([0.1, 0.2, 0.7].map((shippedQuantity, i) => prisma.aSN.create({
        data: {
          id: `ASN-QTY-PARTIAL-${i}`, poId: created.id, vendorId, status: 'Submitted', sapSyncState: 'pending',
          shipDate: new Date(), estimatedDeliveryDate: new Date(),
          items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', shippedQuantity, uom: 'EA' }] },
        },
      })));

      return { po: created, asns: shipments };
    });

    for (const asn of asns) {
      // eslint-disable-next-line no-await-in-loop
      await enqueue({
        clientId: 'CLT-0001', kind: 'awaitGoodsReceipt',
        dedupeKey: `awaitGoodsReceipt:CLT-0001:${asn.id}`,
        args: { asnId: asn.id, poId: po.id, vendorId },
      });
      // eslint-disable-next-line no-await-in-loop
      await until(
        () => runWithTenant('CLT-0001', () => prisma.aSN.findFirst({ where: { id: asn.id, status: 'Received' } })),
        `a goods receipt for ${asn.id}`,
      );
    }

    const poRes = await asBuyer(request(app).get(`/api/pos/${po.id}`));
    expect(poRes.status).toBe(200);
    const line = poRes.body.items.find((i) => i.line === 10);

    // The actual bug (issue #65): a Float grnQuantity accumulating
    // 0.1 + 0.2 + 0.7 lands on 0.9999999999999999, so this comparison and
    // the PO's own Delivered determination (services/poStatus.service.js)
    // both read as "not fully received" even though every unit ordered has
    // arrived.
    expect(line.grnQuantity).toBeCloseTo(1, 6);
    expect(line.grnQuantity >= line.quantity).toBe(true);
    expect(poRes.body.status).toBe('Delivered');
  });
});
