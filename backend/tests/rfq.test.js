const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');

const app = buildTestApp();

// RfqBid.unitPrices was a Mongoose `Map<lineNo, Number>`; it's a child table
// (RfqBidUnitPrice) now. Reassembled into the same `{ [line]: price }` object
// shape the old `.get('10')` callers expect, matching what
// controllers/rfq.controller.js's formatRfq() returns from the real endpoints.
const readRfq = async (id) => {
  const rfq = await prisma.rFQ.findFirst({
    where: { id },
    include: { items: true, invitedVendors: true, bids: { include: { unitPrices: true, uploadedDocs: true } } },
  });
  if (!rfq) return null;
  return {
    ...rfq,
    invitedVendors: rfq.invitedVendors.map((v) => ({ id: v.vendorExtId, name: v.name, status: v.status, rating: v.rating })),
    bids: rfq.bids.map((bid) => ({
      ...bid,
      // RfqBidUnitPrice.price is a Decimal-typed column — Number() here
      // mirrors what controllers/rfq.controller.js's formatBid() does for the
      // real endpoints (see utils/money.js for why a raw Decimal can't be
      // compared with toBe() against a plain number).
      unitPrices: Object.fromEntries(bid.unitPrices.map((u) => [String(u.lineNumber), Number(u.price)])),
    })),
  };
};

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
let auth2;
let buyerAuth;
beforeEach(async () => {
  // Bidding is closed to a supplier who has not submitted their registration
  // (middleware/requireOnboarded.js); this suite is about sourcing, not the gate.
  auth = await registerVendor(app, {}, { onboarded: true });
  // A second competing supplier, for tests where more than one vendor bids
  // on the same RFQ.
  auth2 = await registerVendor(app, {
    vendorId: 'vendor_test_002',
    companyName: 'Beta Supplies Pvt Ltd',
    gstin: '27AABCB1234F1Z6',
    pan: 'AABCB1235F',
    email: 'beta@example.com',
  }, { onboarded: true });
  // Sourcing is a buyer's job: suppliers hold rfq:read and rfq:bid, never
  // rfq:create / rfq:manage / rfq:award (config/permissions.js).
  buyerAuth = await createTenantUser({ role: 'buyer' });
});

const asVendor = (req) => req.set('Authorization', `Bearer ${auth.token}`);
const asVendor2 = (req) => req.set('Authorization', `Bearer ${auth2.token}`);
const asBuyer = (req) => req.set('Authorization', `Bearer ${buyerAuth.token}`);

describe('POST /api/rfqs (create)', () => {
  it('creates an RFQ with a sequential RFQ-YYYY-NNN id and defaults', async () => {
    const res = await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload());

    expect(res.status).toBe(201);
    const year = new Date().getFullYear();
    expect(res.body.id).toBe(`RFQ-${year}-001`);
    expect(res.body.status).toBe('Bidding Open');
    expect(res.body.items).toHaveLength(2);

    const second = await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload());
    expect(second.body.id).toBe(`RFQ-${year}-002`);
  });

  it('rejects missing required fields with 400', async () => {
    const res = await asBuyer(request(app).post('/api/rfqs')).send({ description: 'Too short items', items: [] });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/rfqs', () => {
  it('returns only RFQs the vendor is invited to by default', async () => {
    await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload());
    await asBuyer(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'someone_else' }] })
    );

    const mine = await asVendor(request(app).get('/api/rfqs'));
    expect(mine.status).toBe(200);
    expect(mine.body.rfqs).toHaveLength(1);

    const all = await asBuyer(request(app).get('/api/rfqs?all=true'));
    expect(all.body.rfqs).toHaveLength(2);
  });
});

describe('POST /api/rfqs/:id/bid', () => {
  it('accepts a valid bid from an invited vendor and maps GST to a tax code', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());

    expect(res.status).toBe(200);
    expect(res.body.bidsCount).toBe(1);

    const stored = await asTenant(() => readRfq(rfq.id));
    expect(stored.status).toBe('Bidding Open');
    expect(stored.bids[0].taxCode).toBe('G1'); // 18% → G1
    expect(stored.bids[0].unitPrices['10']).toBe(11.5);
  });

  it('lets a second invited vendor bid after the first — the RFQ stays open, not just for one bidder', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'vendor_test_001' }, { id: 'vendor_test_002' }] })
    )).body;

    const first = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(first.status).toBe(200);
    expect(first.body.bidsCount).toBe(1);

    const second = await asVendor2(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(second.status).toBe(200);
    expect(second.body.bidsCount).toBe(2);

    const stored = await asTenant(() => readRfq(rfq.id));
    expect(stored.status).toBe('Bidding Open');
    expect(stored.bids.map((b) => b.vendorId).sort()).toEqual(['vendor_test_001', 'vendor_test_002']);
  });

  it('replaces rather than duplicates a re-bid from the same vendor', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;

    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(
      bidPayload({ unitPrices: { 10: 9.99, 20: 3.5 } })
    );

    expect(res.status).toBe(200);
    expect(res.body.bidsCount).toBe(1);

    const stored = await asTenant(() => readRfq(rfq.id));
    expect(stored.bids).toHaveLength(1);
    expect(stored.bids[0].unitPrices['10']).toBe(9.99);
  });

  it('rejects a bid from a non-invited vendor with 404 and creates no invitation', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'someone_else' }] })
    )).body;

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    // 404, not 403: the API must not confirm a sealed tender exists to a
    // non-participant (see tenant-isolation.test.js's cross-tenant convention).
    expect(res.status).toBe(404);

    const stored = await asTenant(() => readRfq(rfq.id));
    expect(stored.invitedVendors.map(v => v.id)).not.toContain('vendor_test_001');
    expect(stored.bids).toHaveLength(0);
  });

  it("excludes an uninvited vendor's rejected bid attempt from the evaluation matrix", async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'someone_else' }] })
    )).body;

    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());

    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/evaluate`));
    expect(res.status).toBe(200);
    expect(res.body.evaluation).toHaveLength(0);
  });

  it('rejects a bid missing a line price with 400', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(
      bidPayload({ unitPrices: { 10: 11.5 } })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/line 20/);
  });

  it('rejects a bid after the deadline has passed', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asTenant(() => prisma.rFQ.updateMany({ where: { id: rfq.id }, data: { deadlineDate: new Date(Date.now() - 1000) } }));

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deadline/i);
  });

  it('rejects a bid when bidding is not open', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asTenant(() => prisma.rFQ.updateMany({ where: { id: rfq.id }, data: { status: 'Closed' } }));

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    expect(res.status).toBe(400);
  });
});

describe('POST /api/rfqs/:id/sap-quote-price (ME47)', () => {
  it('pushes the net price to SAP and echoes the document number back', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/sap-quote-price`)).send({
      sapRfqNumber: '6000000062',
      items: [{ line: 10, netPrice: 1400 }, { line: 20, netPrice: 3000 }]
    });

    expect(res.status).toBe(200);
    expect(res.body.sapRfqNumber).toBe('6000000062');

    const entry = await asTenant(() => prisma.sapLog.findFirst({ where: { documentRef: '6000000062' } }));
    expect(entry).toMatchObject({ status: 'SUCCESS', direction: 'OUTBOUND' });
  });

  it('rejects a line number that is not part of this RFQ', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;

    const res = await asVendor(request(app).post(`/api/rfqs/${rfq.id}/sap-quote-price`)).send({
      sapRfqNumber: '6000000062',
      items: [{ line: 99, netPrice: 100 }]
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Line 99/);
  });

  it('404s on an unknown RFQ id', async () => {
    const res = await asVendor(request(app).post('/api/rfqs/RFQ-9999-999/sap-quote-price')).send({
      sapRfqNumber: '6000000062',
      items: [{ line: 10, netPrice: 100 }]
    });
    expect(res.status).toBe(404);
  });

  it('rejects a buyer account — this is a vendor action (rfq:bid), not rfq:manage', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;

    const res = await asBuyer(request(app).post(`/api/rfqs/${rfq.id}/sap-quote-price`)).send({
      sapRfqNumber: '6000000062',
      items: [{ line: 10, netPrice: 100 }]
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/rfqs/:id/evaluate', () => {
  it('scores bids: lowest total cost gets priceScore 100 and ranks first', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(
      rfqPayload({ invitedVendors: [{ id: 'vendor_test_001' }, { id: 'vendor_test_002' }] })
    )).body;

    // Two competing bids submitted through the real API — both vendors were
    // invited, so neither is refused for being "second" (see the "stays open"
    // test above).
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload({
      unitPrices: { 10: 10, 20: 3 }, freight: 0, deliveryLeadTimeDays: 5,
    }));
    await asVendor2(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload({
      unitPrices: { 10: 20, 20: 6 }, freight: 100, deliveryLeadTimeDays: 10,
    }));

    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/evaluate`));
    expect(res.status).toBe(200);
    expect(res.body.evaluation).toHaveLength(2);

    const [first, second] = res.body.evaluation;
    expect(first.vendorId).toBe('vendor_test_001');
    expect(first.totalCost).toBe(10 * 100 + 3 * 200); // 1600
    expect(first.priceScore).toBe(100);
    expect(first.deliveryScore).toBe(100);
    expect(first.weightedScore).toBeGreaterThan(second.weightedScore);
  });

  it('returns an empty evaluation when there are no bids', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/evaluate`));
    expect(res.body.evaluation).toEqual([]);
  });
});

describe('POST /api/rfqs/:id/award', () => {
  it('awards the RFQ and creates a PO priced from the winning bid', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());

    const res = await asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });

    expect(res.status).toBe(200);
    const year = new Date().getFullYear();
    expect(res.body.po.id).toBe(`PO-${year}-0001`);
    expect(res.body.po.fromRfqId).toBe(rfq.id);
    expect(res.body.po.items[0].unitPrice).toBe(11.5);
    expect(res.body.po.items[0].netValue).toBe(11.5 * 100);

    const storedRfq = await asTenant(() => readRfq(rfq.id));
    expect(storedRfq.status).toBe('Awarded');
    expect(storedRfq.convertedPoId).toBe(res.body.po.id);

    const po = await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id: res.body.po.id } }));
    expect(po).toBeTruthy();
  });

  it('rejects awarding twice', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    await asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });

    const res = await asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });
    expect(res.status).toBe(400);
  });

  // The sequential "award, then award again" test above only proves the
  // status check works once a first award has already committed — it cannot
  // catch two requests that both read "not yet Awarded" before either has
  // written anything, which is the actual race a real double-click or a
  // retried request produces. Firing both through Promise.all reproduces
  // that: without the transaction+conditional-update in awardBid, this used
  // to create two real Purchase Orders from one RFQ.
  it('under a genuine race, only one of two simultaneous awards creates a PO', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());

    const [first, second] = await Promise.all([
      asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' }),
      asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' }),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((res) => res.status === 200);
    const losers = outcomes.filter((res) => res.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].status).toBe(400);

    const pos = await asTenant(() => prisma.purchaseOrder.findMany({ where: { fromRfqId: rfq.id } }));
    expect(pos).toHaveLength(1);
    expect(pos[0].id).toBe(winners[0].body.po.id);

    const storedRfq = await asTenant(() => readRfq(rfq.id));
    expect(storedRfq.convertedPoId).toBe(winners[0].body.po.id);
  });

  it('rejects awarding a vendor with no bid', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'ghost_vendor' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/rfqs/:id/export (Phase 5.2 export bridge)', () => {
  const awardedRfq = async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asVendor(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send(bidPayload());
    const award = await asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId: 'vendor_test_001' });
    return { rfq, po: award.body.po };
  };

  it('rejects an export before the RFQ has been awarded', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/export`));
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported format', async () => {
    const { rfq } = await awardedRfq();
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/export?format=pdf`));
    expect(res.status).toBe(400);
  });

  it('defaults to CSV with one row per PO line, headers repeated', async () => {
    const { rfq, po } = await awardedRfq();
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/export`));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${po.id}.csv"`);
    const rows = res.text.trim().split('\r\n');
    expect(rows).toHaveLength(3); // header + 2 PO lines
    expect(rows[1]).toContain(po.id);
    expect(rows[1]).toContain('11.5');
  });

  it('exports structured JSON with the same PO/line data', async () => {
    const { rfq, po } = await awardedRfq();
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/export?format=json`));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.text);
    expect(body.poId).toBe(po.id);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].unitPrice).toBe(11.5);
  });

  it('exports a SpreadsheetML workbook Excel can open, with header and line-item sheets', async () => {
    const { rfq, po } = await awardedRfq();
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/export?format=xlsx`));

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${po.id}.xls"`);
    expect(res.text).toContain('ss:Name="PO Header"');
    expect(res.text).toContain('ss:Name="Line Items"');
    expect(res.text).toContain(po.id);
  });

  it('exports an ORDERS05-shaped IDoc flat file with one E1EDP01 segment per line', async () => {
    const { rfq, po } = await awardedRfq();
    const res = await asBuyer(request(app).get(`/api/rfqs/${rfq.id}/export?format=idoc`));

    expect(res.status).toBe(200);
    expect(res.text).toContain('ORDERS05');
    expect(res.text).toContain(po.id);
    expect(res.text.match(/E1EDP01/g)).toHaveLength(2); // one per PO line
  });
});

describe('cancel and reissue', () => {
  it('cancel closes the RFQ', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    const res = await asBuyer(request(app).put(`/api/rfqs/${rfq.id}/cancel`));

    expect(res.status).toBe(200);
    expect(res.body.rfq.status).toBe('Closed');
  });

  it('reissue reopens bidding with a new deadline', async () => {
    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send(rfqPayload())).body;
    await asBuyer(request(app).put(`/api/rfqs/${rfq.id}/cancel`));

    const newDeadline = futureDate(14);
    const res = await asBuyer(request(app).put(`/api/rfqs/${rfq.id}/reissue`)).send({ deadlineDate: newDeadline });

    expect(res.status).toBe(200);
    expect(res.body.rfq.status).toBe('Bidding Open');
    expect(new Date(res.body.rfq.deadlineDate).toISOString()).toBe(newDeadline);
  });

  it('404s on an unknown RFQ id', async () => {
    const res = await asBuyer(request(app).put('/api/rfqs/RFQ-9999-999/cancel'));
    expect(res.status).toBe(404);
  });
});
