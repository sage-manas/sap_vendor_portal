const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();

// acknowledgePO and submitASN fetched the parent PO by id alone and then
// acted on it using the *caller's* vendor scope — so supplier A could
// acknowledge, or ship against, supplier B's purchase order, stamping A's
// identity onto a document that was never theirs. See issue #52 (the write-side
// counterpart of #51's read-side ownership gap, fixed with the same
// `scopedWhere` helper).
//
// submitInvoice had the same shape of hole (a GRN fetched by id alone, with
// the invoice then created under the caller's vendorId) but the portal no
// longer creates invoices at all — that handler is gone — so only the two
// PO write paths remain to cover here.
describe('cross-supplier PO writes (issue #52)', () => {
  let vendorA;
  let vendorB;

  beforeEach(async () => {
    vendorA = await registerVendor(app, {}, { onboarded: true });
    vendorB = await registerVendor(app, {
      vendorId: 'vendor_test_002',
      companyName: 'Beta Supplies Pvt Ltd',
      gstin: '27AABCB1234F1Z6',
      pan: 'AABCB1235F',
      email: 'beta@example.com',
    }, { onboarded: true });
  });

  const asVendorA = (req) => req.set('Authorization', `Bearer ${vendorA.token}`);
  const asVendorB = (req) => req.set('Authorization', `Bearer ${vendorB.token}`);

  it("A cannot acknowledge B's purchase order, and the PO is left untouched", async () => {
    const po = await asTenant(() => prisma.purchaseOrder.create({
      data: { id: 'PO-2026-9101', vendorId: 'vendor_test_002', status: 'Open' },
    }));

    const res = await asVendorA(request(app).put(`/api/pos/${po.id}/acknowledge`));
    expect(res.status).toBe(404);

    const stored = await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id: po.id } }));
    expect(stored.status).toBe('Open');
    expect(stored.acknowledgedAt).toBeNull();
  });

  it("A cannot ship against B's purchase order, and no ASN or status change is left behind", async () => {
    const po = await asTenant(() => prisma.purchaseOrder.create({
      data: {
        id: 'PO-2026-9102', vendorId: 'vendor_test_002', status: 'Acknowledged',
        items: {
          create: [{
            clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Hex bolts M8',
            quantity: 100, grnQuantity: 0, unitPrice: 10, netValue: 1000, uom: 'EA',
          }],
        },
      },
    }));

    const res = await asVendorA(request(app).post(`/api/pos/${po.id}/asn`).send({
      shipDate: new Date().toISOString(),
      estimatedDeliveryDate: new Date(Date.now() + 86400000).toISOString(),
      items: [{ line: 10, shippedQuantity: 100 }],
    }));
    expect(res.status).toBe(404);

    const stored = await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id: po.id } }));
    expect(stored.status).toBe('Acknowledged');

    const asns = await asTenant(() => prisma.aSN.findMany({ where: { poId: po.id } }));
    expect(asns).toHaveLength(0);
  });

  it('B can still acknowledge and ship against their own order', async () => {
    const po = await asTenant(() => prisma.purchaseOrder.create({
      data: {
        id: 'PO-2026-9103', vendorId: 'vendor_test_002', status: 'Open',
        items: {
          create: [{
            clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Hex bolts M8',
            quantity: 100, grnQuantity: 0, unitPrice: 10, netValue: 1000, uom: 'EA',
          }],
        },
      },
    }));

    const ack = await asVendorB(request(app).put(`/api/pos/${po.id}/acknowledge`));
    expect(ack.status).toBe(200);

    const asn = await asVendorB(request(app).post(`/api/pos/${po.id}/asn`).send({
      shipDate: new Date().toISOString(),
      estimatedDeliveryDate: new Date(Date.now() + 86400000).toISOString(),
      items: [{ line: 10, shippedQuantity: 100 }],
    }));
    expect(asn.status).toBe(201);
  });
});
