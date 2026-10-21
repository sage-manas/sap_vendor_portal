const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createTenantUser } = require('./helpers');

const app = buildTestApp();

// A sealed tender hides rival bids (rfq.test.js) and the invitee list
// (rfq-sealed-invitees.test.js). Issue #287 closed the third gap: the award
// itself. A supplier's RFQ payload carried `awardedVendorId`,
// `awardedVendorName` and `convertedPoId` whoever had won — so the losing
// supplier learnt the winner's identity and the number of the order they got,
// and the portal rendered both. The decision recorded on #287 is that a losing
// supplier is told only that their quotation was not accepted.

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const futureDate = (days = 7) => new Date(Date.now() + days * 86400000).toISOString();

describe('a supplier reading an awarded RFQ learns only their own outcome', () => {
  let winner;
  let loser;
  let buyer;
  let rfqId;
  let poId;

  beforeEach(async () => {
    winner = await registerVendor(app, {}, { onboarded: true });
    loser = await registerVendor(app, {
      vendorId: 'vendor_test_002',
      companyName: 'Beta Supplies Pvt Ltd',
      gstin: '27AABCB1234F1Z6',
      pan: 'AABCB1235F',
      email: 'beta@example.com',
    }, { onboarded: true });
    buyer = await createTenantUser({ role: 'buyer' });

    const created = await request(app).post('/api/rfqs').set(bearer(buyer.token)).send({
      description: 'Sealed tender',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 }],
      invitedVendors: [
        { id: 'vendor_test_001', name: 'Acme Industries Pvt Ltd', rating: 95 },
        { id: 'vendor_test_002', name: 'Beta Supplies Pvt Ltd', rating: 88 },
      ],
    });
    expect(created.status).toBe(201);
    rfqId = created.body.id;

    // Both suppliers quote through the API, and the buyer awards one of them —
    // no row is written behind the endpoints' backs, so the payloads asserted
    // below are the ones a real award produces (AGENTS.md).
    for (const who of [winner, loser]) {
      const bid = await request(app).post(`/api/rfqs/${rfqId}/bid`).set(bearer(who.token)).send({
        unitPrices: { 10: 11.5 },
        gstRate: '18%',
        deliveryLeadTimeDays: 5,
        validityDate: futureDate(30),
        freight: 500,
      });
      expect(bid.status).toBe(200);
    }

    const award = await request(app).post(`/api/rfqs/${rfqId}/award`).set(bearer(buyer.token))
      .send({ vendorId: 'vendor_test_001' });
    expect(award.status).toBe(200);
    poId = award.body.po.id;
  });

  it('never carries a rival supplier bid', async () => {
    const res = await request(app).get(`/api/rfqs/${rfqId}`).set(bearer(loser.token));

    expect(res.status).toBe(200);
    expect(res.body.bids).toHaveLength(1);
    expect(res.body.bids[0].vendorId).toBe('vendor_test_002');
    expect(JSON.stringify(res.body)).not.toMatch(/vendor_test_001|Acme Industries/);
  });

  it('tells a losing supplier the tender closed, without naming the winner or the order', async () => {
    for (const path of [`/api/rfqs/${rfqId}`, '/api/rfqs']) {
      const res = await request(app).get(path).set(bearer(loser.token));
      expect(res.status).toBe(200);
      const rfq = res.body.rfqs ? res.body.rfqs[0] : res.body;

      // The status is theirs to know: the request is decided and closed.
      expect(rfq.status).toBe('Awarded');
      // Who won, when, and against which order are not.
      expect(rfq).not.toHaveProperty('awardedVendorId');
      expect(rfq).not.toHaveProperty('awardedVendorName');
      expect(rfq).not.toHaveProperty('awardedAt');
      expect(rfq).not.toHaveProperty('convertedPoId');
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(poId));
    }
  });

  it('still tells the winning supplier that they won, and which order it became', async () => {
    const res = await request(app).get(`/api/rfqs/${rfqId}`).set(bearer(winner.token));

    expect(res.status).toBe(200);
    expect(res.body.awardedVendorId).toBe('vendor_test_001');
    expect(res.body.convertedPoId).toBe(poId);
  });

  it('refuses a losing supplier the awarded purchase order export', async () => {
    const res = await request(app).get(`/api/rfqs/${rfqId}/export?format=csv`).set(bearer(loser.token));
    expect(res.status).toBe(404);
  });

  it('tenant staff still see the full award', async () => {
    const res = await request(app).get(`/api/rfqs/${rfqId}`).set(bearer(buyer.token));

    expect(res.body.awardedVendorId).toBe('vendor_test_001');
    expect(res.body.awardedVendorName).toMatch(/Acme Industries/);
    expect(res.body.convertedPoId).toBe(poId);
    expect(res.body.bids).toHaveLength(2);
  });
});
