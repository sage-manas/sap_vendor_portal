const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { allRoutes } = require('./routeTable');
const { hasPermission } = require('../config/permissions');
const { ROLES } = require('../config/roles');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');

const app = buildTestApp();

// A by-id lookup that forgets to scope to the calling supplier hands one
// supplier another's document — ids are sequential, so it is an enumeration,
// not a guess. Scoping is opt-in per handler, and one handler
// (GET /api/reports/invoice/:id) had it half-done: it computed the caller's
// supplier id and never used it.
//
// This walks the real router for every GET route with a path parameter that a
// supplier holds the permission for, so a route added tomorrow fails here until
// someone has decided how a second supplier in the same tenant is kept out of
// it. Every document below belongs to supplier B; supplier A must get a 404.

const key = (route) => `GET ${route.path}`;

const supplierReachable = allRoutes.filter(
  (route) =>
    route.method === 'GET' &&
    route.path.includes(':') &&
    !route.path.startsWith('/platform') &&
    route.permission &&
    hasPermission(ROLES.VENDOR, route.permission)
);

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('supplier-reachable GET /:id routes are scoped to the owning supplier', () => {
  let vendorA;
  let vendorB;
  let docs;

  beforeEach(async () => {
    vendorA = await registerVendor(app, {}, { onboarded: true });
    vendorB = await registerVendor(app, {
      vendorId: 'vendor_test_002',
      companyName: 'Beta Supplies Pvt Ltd',
      gstin: '27AABCB1234F1Z6',
      pan: 'AABCB1235F',
      email: 'beta@example.com',
    }, { onboarded: true });
    const buyer = await createTenantUser({ role: 'buyer' });

    // Supplier B's downstream documents are preconditions for this test, not
    // what it exercises. The API can produce the chain (RFQ → award → ASN →
    // GRN → invoice) but walking it here would test the pipeline; the same
    // seeding pattern is already used by cross-supplier-document-access.test.js.
    const seeded = await asTenant(async () => {
      const po = await prisma.purchaseOrder.create({
        data: { id: 'PO-2026-9001', vendorId: 'vendor_test_002', status: 'Acknowledged' },
      });
      const asn = await prisma.aSN.create({
        data: {
          id: 'ASN-900001', poId: po.id, vendorId: 'vendor_test_002',
          shipDate: new Date(), estimatedDeliveryDate: new Date(Date.now() + 86400000),
        },
      });
      const grn = await prisma.gRN.create({
        data: { id: 'GRN-900001', poId: po.id, asnId: asn.id, vendorId: 'vendor_test_002', postingDate: new Date() },
      });
      const invoice = await prisma.invoice.create({
        data: {
          id: 'INV-900001', grnId: grn.id, poId: po.id, vendorId: 'vendor_test_002',
          invoiceNumber: 'B/1', invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118,
        },
      });
      const payment = await prisma.payment.create({
        data: {
          id: 'PMT-900001', vendorId: 'vendor_test_002',
          netAmount: 118, paymentDate: new Date(), utrCode: 'UTRB9001',
          items: { create: [{ clientId: 'CLT-0001', invoiceId: invoice.id, poId: po.id, netAmount: 118 }] },
        },
      });
      return { po, grn, invoice, payment };
    });

    // The rest go through the API.
    const rfq = await request(app).post('/api/rfqs').set(bearer(buyer.token)).send({
      description: 'Scoped to B',
      deadlineDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 }],
      invitedVendors: [{ id: 'vendor_test_002', name: 'Beta Supplies Pvt Ltd', rating: 90 }],
    });
    expect(rfq.status).toBe(201);

    const upload = await request(app)
      .post('/api/uploads')
      .set(bearer(vendorB.token))
      .attach('file', Buffer.from('%PDF-1.4 beta'), 'beta.pdf');
    expect(upload.status).toBe(201);

    docs = { ...seeded, rfqId: rfq.body.id, documentId: upload.body.documentId };
  });

  // owner: what the rightful owner (B) gets, so a blanket 404 can't pass.
  const fixtures = {
    'GET /rfqs/:id': { path: () => `/rfqs/${docs.rfqId}`, owner: 200 },
    // Not awarded, so the owner is told so; a non-invitee must not be able to
    // learn the tender exists from that same answer.
    'GET /rfqs/:id/export': { path: () => `/rfqs/${docs.rfqId}/export`, owner: 400 },
    'GET /pos/:id': { path: () => `/pos/${docs.po.id}`, owner: 200 },
    'GET /pos/:id/invoice-plan': { path: () => `/pos/${docs.po.id}/invoice-plan`, owner: 200 },
    'GET /pos/:id/asn': { path: () => `/pos/${docs.po.id}/asn`, owner: 200 },
    'GET /grns/:id': { path: () => `/grns/${docs.grn.id}`, owner: 200 },
    'GET /invoices/:id': { path: () => `/invoices/${docs.invoice.id}`, owner: 200 },
    'GET /payments/:id': { path: () => `/payments/${docs.payment.id}`, owner: 200 },
    'GET /uploads/:id': { path: () => `/uploads/${docs.documentId}`, owner: 200 },
    'GET /reports/invoice/:id': { path: () => `/reports/invoice/${docs.invoice.id}`, owner: 200 },
  };

  it('has a fixture for every supplier-reachable GET route with a path parameter', () => {
    const missing = supplierReachable.map(key).filter((route) => !fixtures[route]);
    expect(missing).toEqual([]);
    expect(Object.keys(fixtures).filter((route) => !supplierReachable.map(key).includes(route))).toEqual([]);
  });

  it.each(Object.keys(fixtures))('%s: a second supplier in the same tenant gets 404', async (route) => {
    const res = await request(app).get(`/api${fixtures[route].path()}`).set(bearer(vendorA.token));
    expect(res.status).toBe(404);
  });

  it.each(Object.keys(fixtures))('%s: the owning supplier is not locked out', async (route) => {
    const res = await request(app).get(`/api${fixtures[route].path()}`).set(bearer(vendorB.token));
    expect(res.status).toBe(fixtures[route].owner);
  });
});
