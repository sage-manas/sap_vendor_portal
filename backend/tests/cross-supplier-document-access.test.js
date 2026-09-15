const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();

// GET /api/pos/:id, /api/pos/:id/asn, /api/invoices/:id, /api/payments/:id and
// /api/grns/:id used to resolve on `{ id: req.params.id }` alone — the tenant
// extension kept the lookup inside the right tenant, but nothing stopped it
// resolving to another supplier's document within that tenant. See issue #51.
//
// Each document below belongs to vendor B; vendor A must get the same 404 a
// nonexistent id would produce. Tenant staff (buyer/finance/client_admin) are
// not scoped to one supplier and are unaffected — a spot check for that sits
// alongside each case, not a full second matrix, since staff-side visibility
// isn't what changed here.
describe('cross-supplier document access (issue #51)', () => {
  let vendorA;
  let vendorB;
  let po;
  let asn;
  let grn;
  let invoice;
  let payment;

  beforeEach(async () => {
    vendorA = await registerVendor(app, {}, { onboarded: true });
    vendorB = await registerVendor(app, {
      vendorId: 'vendor_test_002',
      companyName: 'Beta Supplies Pvt Ltd',
      gstin: '27AABCB1234F1Z6',
      pan: 'AABCB1235F',
      email: 'beta@example.com',
    }, { onboarded: true });

    // B's documents, seeded directly — the API can produce this chain (RFQ →
    // award → ASN → GRN → …) but exercising all of that here would test the
    // pipeline, not the ownership check; these are preconditions, not the
    // thing under test.
    await asTenant(async () => {
      po = await prisma.purchaseOrder.create({
        data: { id: 'PO-2026-9001', vendorId: 'vendor_test_002', status: 'Acknowledged' },
      });
      asn = await prisma.aSN.create({
        data: {
          id: 'ASN-900001', poId: po.id, vendorId: 'vendor_test_002',
          shipDate: new Date(), estimatedDeliveryDate: new Date(Date.now() + 86400000),
        },
      });
      grn = await prisma.gRN.create({
        data: { id: 'GRN-900001', poId: po.id, asnId: asn.id, vendorId: 'vendor_test_002', postingDate: new Date() },
      });
      invoice = await prisma.invoice.create({
        data: {
          id: 'INV-900001', grnId: grn.id, poId: po.id, vendorId: 'vendor_test_002',
          invoiceNumber: 'B/1', invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118,
        },
      });
      payment = await prisma.payment.create({
        data: {
          id: 'PMT-900001', invoiceId: invoice.id, poId: po.id, vendorId: 'vendor_test_002',
          netAmount: 118, paymentDate: new Date(), utrCode: 'UTRB9001',
        },
      });
    });
  });

  const asVendorA = (req) => req.set('Authorization', `Bearer ${vendorA.token}`);
  const asVendorB = (req) => req.set('Authorization', `Bearer ${vendorB.token}`);

  it.each([
    ['PO', () => `/api/pos/${po.id}`, '/api/pos/PO-2026-9999'],
    ['ASN list for PO', () => `/api/pos/${po.id}/asn`, '/api/pos/PO-2026-9999/asn'],
    ['Invoice', () => `/api/invoices/${invoice.id}`, '/api/invoices/INV-999999'],
    ['Payment', () => `/api/payments/${payment.id}`, '/api/payments/PMT-999999'],
    ['GRN', () => `/api/grns/${grn.id}`, '/api/grns/GRN-999999'],
  ])('GET %s belonging to another supplier → 404, same shape as a nonexistent id', async (_label, ownedPath, bogusPath) => {
    const owned = await asVendorA(request(app).get(ownedPath()));
    expect(owned.status).toBe(404);

    const bogus = await asVendorA(request(app).get(bogusPath));
    expect(bogus.status).toBe(404);
    expect(owned.body).toEqual(bogus.body);
  });

  it('the owning supplier can still read every one of their own documents', async () => {
    expect((await asVendorB(request(app).get(`/api/pos/${po.id}`))).status).toBe(200);
    expect((await asVendorB(request(app).get(`/api/pos/${po.id}/asn`))).status).toBe(200);
    expect((await asVendorB(request(app).get(`/api/invoices/${invoice.id}`))).status).toBe(200);
    expect((await asVendorB(request(app).get(`/api/payments/${payment.id}`))).status).toBe(200);
    expect((await asVendorB(request(app).get(`/api/grns/${grn.id}`))).status).toBe(200);
  });
});
