const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

// Finding 4.1. `getASNs` opened with `requireVendorScope(req)`, which throws
// 400 "vendorId is required for this action" for any caller that is not a
// supplier. So the buying organisation — whose goods these shipments are
// inbound to — could not see them at all, despite every staff role already
// holding `asn:read` (config/permissions.js, TENANT_READ_ONLY).
//
// That was the one exception to a contract every other document type keeps:
// tenant-wide to staff, own-rows-only to a supplier, decided by
// `withVendorScope` rather than by each controller. tests/tenant-wide-
// visibility.test.js records that contract for RFQs, POs, invoices and
// payments; this file extends it to shipments, which is where it should have
// been all along.
//
// The endpoint also now answers `{ asns, pagination }` instead of a bare
// array of every row. It was the only list shaped that way (src/test/
// fixtures.js said so in a comment) and is one of the endpoints issue #186
// lists — and going tenant-wide turns an unbounded response from a latent
// problem into a real one, since a workspace has every supplier's shipments
// rather than one supplier's.
//
// Seeding note (AGENTS.md): the purchase orders below are preconditions, not
// the thing under test. An ASN is raised through `POST /api/pos/:id/asn` and
// that is how every shipment here is created — the PO it ships against is the
// precondition, and a PO is produced by awarding an RFQ, which this suite does
// not exercise.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const seedPoFor = (vendorId, poId) => asTenant(() => prisma.purchaseOrder.create({
  data: {
    id: poId,
    vendorId,
    items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, unitPrice: 10, netValue: 1000 }] },
  },
}));

const asnPayload = (overrides = {}) => ({
  shipDate: new Date().toISOString(),
  estimatedDeliveryDate: new Date(Date.now() + 5 * 86400000).toISOString(),
  carrierName: 'Blue Dart Express',
  trackingNumber: 'BD123456789',
  items: [{ line: 10, shippedQuantity: 100 }],
  ...overrides,
});

// Two suppliers, each with one purchase order and one shipment raised against
// it through the API.
const seedTwoShipments = async () => {
  const a = await registerVendor(app, {
    vendorId: 'vendor_ship_a', companyName: 'Acme Industries Pvt Ltd', gstin: '27AAAAA4441A1Z1',
  }, { onboarded: true });
  const b = await registerVendor(app, {
    vendorId: 'vendor_ship_b', companyName: 'Beta Supplies Pvt Ltd', gstin: '27AAAAA4442A1Z1',
    pan: 'AAAAA4442A', email: 'beta-ship@example.com',
  }, { onboarded: true });

  await seedPoFor('vendor_ship_a', 'PO-2026-SA');
  await seedPoFor('vendor_ship_b', 'PO-2026-SB');

  // The API refuses a shipment against an unacknowledged order, so the
  // acknowledgement goes through its own endpoint too rather than being
  // seeded as a status -- it is a state the API produces (AGENTS.md).
  expect((await request(app).put('/api/pos/PO-2026-SA/acknowledge').set(auth(a.token))).status).toBe(200);
  expect((await request(app).put('/api/pos/PO-2026-SB/acknowledge').set(auth(b.token))).status).toBe(200);

  const first = await request(app).post('/api/pos/PO-2026-SA/asn').set(auth(a.token)).send(asnPayload());
  const second = await request(app).post('/api/pos/PO-2026-SB/asn').set(auth(b.token)).send(asnPayload({ trackingNumber: 'BD987654321' }));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);

  return { a, b, first: first.body, second: second.body };
};

describe.each([
  ['client_admin', ROLES.CLIENT_ADMIN],
  ['buyer', ROLES.BUYER],
  ['finance', ROLES.FINANCE],
])('tenant staff can see the shipments inbound to them (%s)', (label, role) => {
  it('lists every supplier\'s shipments', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/asns').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.asns.map((asn) => asn.vendorId).sort()).toEqual(['vendor_ship_a', 'vendor_ship_b']);
  });

  it('does not refuse the request for want of a vendorId', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/asns').set(auth(token));

    // The defect: a 400 asking the caller to name a supplier, to a role whose
    // whole job is to look across all of them.
    expect(res.status).not.toBe(400);
  });

  it('can still narrow to one supplier explicitly', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/asns').set(auth(token)).query({ vendorId: 'vendor_ship_b' });

    expect(res.status).toBe(200);
    expect(res.body.asns.map((asn) => asn.vendorId)).toEqual(['vendor_ship_b']);
  });
});

describe('a supplier still sees only their own shipments', () => {
  it('does not show one supplier another supplier\'s shipment', async () => {
    const { a } = await seedTwoShipments();

    const res = await request(app).get('/api/asns').set(auth(a.token));

    expect(res.status).toBe(200);
    expect(res.body.asns.map((asn) => asn.vendorId)).toEqual(['vendor_ship_a']);
  });

  it('ignores a vendorId naming another supplier', async () => {
    const { a } = await seedTwoShipments();

    // The supplier plane is pinned to its own vendorId whatever the request
    // says (utils/requestScope.js) — asserted here because this endpoint now
    // reads ?vendorId= at all, which it did not before.
    const res = await request(app).get('/api/asns').set(auth(a.token)).query({ vendorId: 'vendor_ship_b' });

    expect(res.status).toBe(200);
    expect(res.body.asns.map((asn) => asn.vendorId)).toEqual(['vendor_ship_a']);
  });
});

describe('the shipments list is paginated like every other list', () => {
  it('answers { asns, pagination }, not a bare array', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app).get('/api/asns').set(auth(token));

    expect(Array.isArray(res.body)).toBe(false);
    expect(res.body.pagination).toMatchObject({ total: 2, page: 1, pages: 1 });
  });

  it('pages through, newest first', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const first = await request(app).get('/api/asns').set(auth(token)).query({ page: 1, limit: 1 });
    const second = await request(app).get('/api/asns').set(auth(token)).query({ page: 2, limit: 1 });

    expect(first.body.asns).toHaveLength(1);
    expect(second.body.asns).toHaveLength(1);
    expect(first.body.pagination).toMatchObject({ total: 2, page: 1, limit: 1, pages: 2 });
    // Two distinct rows, not the same one twice.
    expect(first.body.asns[0].id).not.toBe(second.body.asns[0].id);
  });

  it('refuses an unbounded limit rather than returning every row', async () => {
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    // Issue #118's ceiling, now applied here too.
    expect((await request(app).get('/api/asns').set(auth(token)).query({ limit: 1000000 })).status).toBe(400);
    expect((await request(app).get('/api/asns').set(auth(token)).query({ limit: 'abc' })).status).toBe(400);
  });

  it('filters by status without losing the filter to query validation', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    // paginationSchema is .passthrough() for exactly this reason — a schema
    // that stripped unnamed keys would silently drop `status`.
    const matching = await request(app).get('/api/asns').set(auth(token)).query({ status: 'Submitted' });
    const none = await request(app).get('/api/asns').set(auth(token)).query({ status: 'Delivered' });

    expect(matching.body.asns).toHaveLength(2);
    expect(none.body.asns).toHaveLength(0);
  });
});

describe('shipments stay inside the tenant', () => {
  it('does not show another tenant\'s shipments', async () => {
    await seedTwoShipments();
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    // A shipment belonging to a different client, seeded as a precondition
    // this suite is not exercising — the same shape tests/tenant-isolation.js
    // uses. The tenant extension is what must exclude it.
    await asTenant(async () => {
      await prisma.purchaseOrder.create({ data: { id: 'PO-OTHER-1', vendorId: 'vendor_other' } });
    }, 'CLT-0002');
    await asTenant(async () => {
      await prisma.aSN.create({
        data: {
          id: 'ASN-OTHER-1', poId: 'PO-OTHER-1', vendorId: 'vendor_other',
          shipDate: new Date(), estimatedDeliveryDate: new Date(),
        },
      });
    }, 'CLT-0002');

    const res = await request(app).get('/api/asns').set(auth(token));

    expect(res.body.asns.map((asn) => asn.id)).not.toContain('ASN-OTHER-1');
    expect(res.body.pagination.total).toBe(2);
  });
});
