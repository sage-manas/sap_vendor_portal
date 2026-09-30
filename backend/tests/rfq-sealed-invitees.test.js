const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createTenantUser } = require('./helpers');

const app = buildTestApp();

// A sealed tender hides rival bids (rfq.test.js). It must also hide who else
// was asked to bid: the invitee list names the competitors, and formatRfq
// returned it to every invited supplier.

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('a supplier reading an RFQ does not learn who else was invited', () => {
  let a;
  let b;
  let buyer;
  let rfqId;

  beforeEach(async () => {
    a = await registerVendor(app, {}, { onboarded: true });
    b = await registerVendor(app, {
      vendorId: 'vendor_test_002',
      companyName: 'Beta Supplies Pvt Ltd',
      gstin: '27AABCB1234F1Z6',
      pan: 'AABCB1235F',
      email: 'beta@example.com',
    }, { onboarded: true });
    buyer = await createTenantUser({ role: 'buyer' });

    const created = await request(app).post('/api/rfqs').set(bearer(buyer.token)).send({
      description: 'Sealed tender',
      deadlineDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 }],
      invitedVendors: [
        { id: 'vendor_test_001', name: 'Acme Industries Pvt Ltd', rating: 95 },
        { id: 'vendor_test_002', name: 'Beta Supplies Pvt Ltd', rating: 88 },
      ],
    });
    expect(created.status).toBe(201);
    rfqId = created.body.id;
  });

  it('GET /api/rfqs/:id carries no invitee list and no rival name or code', async () => {
    const res = await request(app).get(`/api/rfqs/${rfqId}`).set(bearer(a.token));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(rfqId);
    expect(res.body).not.toHaveProperty('invitedVendors');
    expect(JSON.stringify(res.body)).not.toMatch(/Beta Supplies|vendor_test_002/);
  });

  it('GET /api/rfqs carries no invitee list and no rival name or code', async () => {
    const res = await request(app).get('/api/rfqs').set(bearer(a.token));

    expect(res.status).toBe(200);
    expect(res.body.rfqs).toHaveLength(1);
    expect(res.body.rfqs[0]).not.toHaveProperty('invitedVendors');
    expect(JSON.stringify(res.body)).not.toMatch(/Beta Supplies|vendor_test_002/);
  });

  it('tenant staff still see who was invited', async () => {
    const one = await request(app).get(`/api/rfqs/${rfqId}`).set(bearer(buyer.token));
    expect(one.body.invitedVendors.map((v) => v.id).sort()).toEqual(['vendor_test_001', 'vendor_test_002']);

    const list = await request(app).get('/api/rfqs').set(bearer(buyer.token));
    expect(list.body.rfqs[0].invitedVendors).toHaveLength(2);
  });
});
