const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

// Issue #125. `RFQ.purchasingOrg` and `RFQ.companyCode` defaulted to '1000' in
// the schema, and `RfqItem.plant` did too. '1000' is SAP's IDES demo value —
// this project's own sandbox uses SSDN — so every RFQ in a supplier's list read
// "Org: 1000" whether or not anyone had chosen it.
//
// The part that made it more than cosmetic: `awardBid` carries the RFQ's
// organisational scope onto the purchase order it creates. Issue #62 had
// already established, for `PurchaseOrder`, that "a value on a purchase order
// means a real one was supplied, never that '1000' was assumed" — and the
// default the PO refuses to invent for itself arrived through the RFQ anyway.
// So this suite's load-bearing assertion is the award one: an awarded PO
// inherits only a scope the RFQ really had.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const rfqPayload = (overrides = {}) => ({
  description: 'Industrial fasteners bulk order',
  deadlineDate: futureDate(),
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 }],
  invitedVendors: [{ id: 'vendor_test_001', name: 'Acme Industries Pvt Ltd', rating: 95 }],
  ...overrides,
});

const bidPayload = (overrides = {}) => ({
  unitPrices: { 10: 11.5 },
  gstRate: '18%',
  deliveryLeadTimeDays: 5,
  validityDate: futureDate(30),
  freight: 0,
  ...overrides,
});

// Writes a sourcing setting the way the workspace settings screen does, so the
// inheritance below is exercised through the shape an operator actually
// produces rather than a hand-built Client row.
const setSourcing = (values) => withoutTenantScope(async () => {
  const client = await rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } });
  await rawPrisma.client.update({
    where: { pk: client.pk },
    data: { settings: { ...(client.settings || {}), sourcing: values } },
  });
});

const readRfq = (id) => asTenant(() => prisma.rFQ.findFirst({ where: { id }, include: { items: true } }));

let buyerAuth;
let vendorAuth;
beforeEach(async () => {
  vendorAuth = await registerVendor(app, {}, { onboarded: true });
  buyerAuth = await createTenantUser({ role: ROLES.BUYER });
});

const createRfq = (body) => request(app).post('/api/rfqs').set(auth(buyerAuth.token)).send(rfqPayload(body));

describe('an RFQ nobody gave an organisational scope to has none', () => {
  it('stores null rather than the demo value 1000', async () => {
    const res = await createRfq();

    expect(res.status).toBe(201);
    expect(res.body.purchasingOrg).toBeNull();
    expect(res.body.companyCode).toBeNull();

    const stored = await readRfq(res.body.id);
    expect(stored.purchasingOrg).toBeNull();
    expect(stored.companyCode).toBeNull();
    expect(stored.purchasingGroup).toBeNull();
  });

  it('stores a null plant on a line that did not state one', async () => {
    const res = await createRfq();

    const stored = await readRfq(res.body.id);
    expect(stored.items[0].plant).toBeNull();
  });

  it('does not invent a delivery location either', async () => {
    // 'Plant 1000' was the same invention wearing a label — an address nobody
    // stated, printed to suppliers as though someone had.
    const res = await createRfq();

    expect(res.body.deliveryLocation).toBeNull();
  });
});

describe('a scope the buyer states is the scope that is stored', () => {
  it('takes purchasingOrg, companyCode and purchasingGroup from the request', async () => {
    const res = await createRfq({ purchasingOrg: 'SSDN', companyCode: 'SSDN', purchasingGroup: '001' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ purchasingOrg: 'SSDN', companyCode: 'SSDN', purchasingGroup: '001' });
  });

  it('takes the plant a line states', async () => {
    const res = await createRfq({
      items: [{ line: 10, materialCode: 'MAT-001', quantity: 100, targetPrice: 12, plant: 'PL01' }],
    });

    const stored = await readRfq(res.body.id);
    expect(stored.items[0].plant).toBe('PL01');
  });

  it('refuses a scope longer than SAP\'s own field', async () => {
    // EKORG and BUKRS are CHAR(4), EKGRP CHAR(3).
    expect((await createRfq({ purchasingOrg: 'TOOLONG' })).status).toBe(400);
    expect((await createRfq({ companyCode: 'TOOLONG' })).status).toBe(400);
    expect((await createRfq({ purchasingGroup: '0001' })).status).toBe(400);
  });
});

describe('a workspace can state its scope once instead of per document', () => {
  it('inherits the sourcing setting when the request does not state one', async () => {
    await setSourcing({ purchasingOrg: 'SSDN', companyCode: 'SSDN', purchasingGroup: '002' });

    const res = await createRfq();

    expect(res.body).toMatchObject({ purchasingOrg: 'SSDN', companyCode: 'SSDN', purchasingGroup: '002' });
  });

  it('lets the request override the setting', async () => {
    await setSourcing({ purchasingOrg: 'SSDN', companyCode: 'SSDN' });

    const res = await createRfq({ purchasingOrg: 'ZZZZ' });

    expect(res.body.purchasingOrg).toBe('ZZZZ');
    // The one the request did not mention still comes from the setting.
    expect(res.body.companyCode).toBe('SSDN');
  });

  it('treats an empty setting as unset, not as a zero-length code', async () => {
    // Every text setting's "unset" is '' (config/tenantSettings.js), so this
    // is the ordinary state of a workspace that has not configured sourcing.
    await setSourcing({ purchasingOrg: '', companyCode: '', purchasingGroup: '' });

    const res = await createRfq();

    expect(res.body.purchasingOrg).toBeNull();
    expect(res.body.companyCode).toBeNull();
  });
});

describe('an awarded purchase order inherits only a scope the RFQ really had', () => {
  const award = async (rfqId) => {
    await request(app).post(`/api/rfqs/${rfqId}/bid`).set(auth(vendorAuth.token)).send(bidPayload());
    return request(app).post(`/api/rfqs/${rfqId}/award`).set(auth(buyerAuth.token)).send({ vendorId: 'vendor_test_001' });
  };

  // This is the assertion the issue is really about: issue #62 made
  // PurchaseOrder's org fields nullable with no defaults precisely so a value
  // there would mean something, and the RFQ default was handing it a '1000'
  // regardless.
  it('leaves the purchase order\'s scope null when the RFQ had none', async () => {
    const rfq = (await createRfq()).body;

    const res = await award(rfq.id);

    expect(res.status).toBe(200);
    expect(res.body.po.purchasingOrg).toBeNull();
    expect(res.body.po.companyCode).toBeNull();
    expect(res.body.po.purchasingGroup).toBeNull();
    expect(res.body.po.items[0].plant).toBeNull();
  });

  it('carries a real scope through to the purchase order', async () => {
    const rfq = (await createRfq({
      purchasingOrg: 'SSDN', companyCode: 'SSDN', purchasingGroup: '001',
      items: [{ line: 10, materialCode: 'MAT-001', quantity: 100, targetPrice: 12, plant: 'PL01' }],
    })).body;

    const res = await award(rfq.id);

    expect(res.body.po).toMatchObject({ purchasingOrg: 'SSDN', companyCode: 'SSDN', purchasingGroup: '001' });
    expect(res.body.po.items[0].plant).toBe('PL01');
  });

  it('carries an inherited scope through too', async () => {
    await setSourcing({ purchasingOrg: 'SSDN', companyCode: 'SSDN' });
    const rfq = (await createRfq()).body;

    const res = await award(rfq.id);

    expect(res.body.po).toMatchObject({ purchasingOrg: 'SSDN', companyCode: 'SSDN' });
  });
});

describe('the sourcing settings are offered to the workspace', () => {
  it('appear in GET /api/workspace/settings as their own group', async () => {
    const admin = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app).get('/api/workspace/settings').set(auth(admin.token));

    expect(res.status).toBe(200);
    const group = res.body.groups.find((entry) => entry.key === 'sourcing');
    expect(group).toBeTruthy();
    expect(group.settings.map((setting) => setting.key).sort()).toEqual([
      'sourcing.companyCode', 'sourcing.purchasingGroup', 'sourcing.purchasingOrg',
    ]);
    // Empty by default, which is what makes "nobody chose one" the starting
    // state rather than '1000'.
    expect(group.settings.every((setting) => setting.value === '')).toBe(true);
  });

  it('can be set through PATCH /api/workspace/settings', async () => {
    const admin = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app).patch('/api/workspace/settings').set(auth(admin.token))
      .send({ settings: { 'sourcing.purchasingOrg': 'SSDN' } });

    expect(res.status).toBe(200);
    const created = await createRfq();
    expect(created.body.purchasingOrg).toBe('SSDN');
  });
});
