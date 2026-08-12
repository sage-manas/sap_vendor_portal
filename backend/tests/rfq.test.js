const request = require('supertest');
const buildTestApp = require('./testApp');
const RFQ = require('../models/RFQ');
const PurchaseOrder = require('../models/PurchaseOrder');
const { registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();

const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const rfqPayload = (overrides = {}) => ({
  description: 'Industrial fasteners bulk order',
  deadlineDate: futureDate(),
  items: [
    { line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 },
    { line: 20, materialCode: 'MAT-002', description: 'Nuts M8', quantity: 200, targetPrice: 4 }
  ],
  invitedVendors: [{ id: 'vendor_test_001', name: 'Acme Industries Pvt Ltd', rating: 95 }],
  ...overrides
});

const bidPayload = (overrides = {}) => ({
  unitPrices: { 10: 11.5, 20: 3.8 },
  gstRate: '18%',
  deliveryLeadTimeDays: 5,
  validityDate: futureDate(30),
  freight: 500,
  ...overrides
});

let auth;
beforeEach(async () => {
  auth = await registerVendor(app);
});

const asVendor = (req) => req.set('Authorization', `Bearer ${auth.token}`);

describe('POST /api/rfqs (create)', () => {
  it('creates an RFQ with a sequential RFQ-YYYY-NNN id and defaults', async () => {
    const res = await asVendor(request(app).post('/api/rfqs')).send(rfqPayload());

    expect(res.status).toBe(201);
    const year = new Date().getFullYear();
    expect(res.body.id).toBe(`RFQ-${year}-001`);
    expect(res.body.status).toBe('Bidding Open');
    expect(res.body.items).toHaveLength(2);

    const second = await asVendor(request(app).post('/api/rfqs')).send(rfqPayload());
    expect(second.body.id).toBe(`RFQ-${year}-002`);
  });

  it('rejects missing required fields with 400', async () => {
    const res = await asVendor(request(app).post('/api/rfqs')).send({ description: 'Too short items', items: [] });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/rfqs', () => {
  it('returns only RFQs the vendor is invited to by default', async () => {
    await asVendor(request(app).post('/api/rfqs')).send(rfqPayload());
    await asVendor(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'someone_else' }] })
    );

    const mine = await asVendor(request(app).get('/api/rfqs'));
    expect(mine.status).toBe(200);
    expect(mine.body.rfqs).toHaveLength(1);

    const all = await asVendor(request(app).get('/api/rfqs?all=true'));
    expect(all.body.rfqs).toHaveLength(2);
  });
});

describe('POST /api/rfqs/:id/bid', () => {
  it('accepts a valid bid from an invited vendor and maps GST to a tax code', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());

    expect(res.status).toBe(200);
    expect(res.body.bidsCount).toBe(1);

    const stored = await asTenant(() => RFQ.findOne({ id: rfq.id }));
    expect(stored.status).toBe('Submitted');
    expect(stored.bids[0].taxCode).toBe('G1'); // 18% → G1
    expect(stored.bids[0].unitPrices.get('10')).toBe(11.5);
  });

  it('accepts a bid from a non-invited vendor by dynamically inviting them', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'someone_else' }] })
    )).body;

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(res.status).toBe(200);

    const stored = await asTenant(() => RFQ.findOne({ id: rfq.id }));
    expect(stored.invitedVendors.map(v => v.id)).toContain('vendor_test_001');
  });

  it('rejects a bid missing a line price with 400', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(
      bidPayload({ unitPrices: { 10: 11.5 } })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/line 20/);
  });

  it('rejects a bid after the deadline has passed', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asTenant(() => RFQ.updateOne({ id: rfq.id }, { deadlineDate: new Date(Date.now() - 1000) }));

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deadline/i);
  });

  it('rejects a bid when bidding is not open', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asTenant(() => RFQ.updateOne({ id: rfq.id }, { status: 'Closed' }));

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(res.status).toBe(400);
  });
});

describe('GET /api/rfqs/:id/evaluate', () => {
  it('scores bids: lowest total cost gets priceScore 100 and ranks first', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;

    // Seed two competing bids directly (API closes bidding after the first bid)
    await asTenant(() => RFQ.updateOne({ id: rfq.id }, {
      $set: {
        bids: [
          { vendorId: 'v_cheap', vendorName: 'Cheap Co', unitPrices: { 10: 10, 20: 3 }, freight: 0, deliveryLeadTimeDays: 5, technicalScore: 80, vendorRating: 90 },
          { vendorId: 'v_costly', vendorName: 'Costly Co', unitPrices: { 10: 20, 20: 6 }, freight: 100, deliveryLeadTimeDays: 10, technicalScore: 80, vendorRating: 90 }
        ]
      }
    }));

    const res = await asVendor(request(app).get(`/api/rfqs/${rfq.id}/evaluate`));
    expect(res.status).toBe(200);
    expect(res.body.evaluation).toHaveLength(2);

    const [first, second] = res.body.evaluation;
    expect(first.vendorId).toBe('v_cheap');
    expect(first.totalCost).toBe(10 * 100 + 3 * 200); // 1600
    expect(first.priceScore).toBe(100);
    expect(first.deliveryScore).toBe(100);
    expect(first.weightedScore).toBeGreaterThan(second.weightedScore);
  });

  it('returns an empty evaluation when there are no bids', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).get(`/api/rfqs/${rfq.id}/evaluate`));
    expect(res.body.evaluation).toEqual([]);
  });
});

describe('POST /api/rfqs/:id/award', () => {
  it('awards the RFQ and creates a PO priced from the winning bid', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });

    expect(res.status).toBe(200);
    const year = new Date().getFullYear();
    expect(res.body.po.id).toBe(`PO-${year}-0001`);
    expect(res.body.po.fromRfqId).toBe(rfq.id);
    expect(res.body.po.items[0].unitPrice).toBe(11.5);
    expect(res.body.po.items[0].netValue).toBe(11.5 * 100);

    const storedRfq = await asTenant(() => RFQ.findOne({ id: rfq.id }));
    expect(storedRfq.status).toBe('Awarded');
    expect(storedRfq.convertedPoId).toBe(res.body.po.id);

    const po = await asTenant(() => PurchaseOrder.findOne({ id: res.body.po.id }));
    expect(po).toBeTruthy();
  });

  it('rejects awarding twice', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });
    expect(res.status).toBe(400);
  });

  it('rejects awarding a vendor with no bid', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'ghost_vendor' });
    expect(res.status).toBe(404);
  });
});

describe('cancel and reissue', () => {
  it('cancel closes the RFQ', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).put(`/api/rfqs/${rfq.id}/cancel`));

    expect(res.status).toBe(200);
    expect(res.body.rfq.status).toBe('Closed');
  });

  it('reissue reopens bidding with a new deadline', async () => {
    const rfq = (await asVendor(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).put(`/api/rfqs/${rfq.id}/cancel`));

    const newDeadline = futureDate(14);
    const res = await asVendor(request(app).put(`/api/rfqs/${rfq.id}/reissue`)).send({ deadlineDate: newDeadline });

    expect(res.status).toBe(200);
    expect(res.body.rfq.status).toBe('Bidding Open');
    expect(new Date(res.body.rfq.deadlineDate).toISOString()).toBe(newDeadline);
  });

  it('404s on an unknown RFQ id', async () => {
    const res = await asVendor(request(app).put('/api/rfqs/RFQ-9999-999/cancel'));
    expect(res.status).toBe(404);
  });
});
