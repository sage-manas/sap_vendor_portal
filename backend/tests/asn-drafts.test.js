const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

// Shipment notice drafts (the user's decision, 2026-11-20): a draft is saved
// at any point, takes no ASN number, reserves nothing, and is checked by
// every submit rule only when it is submitted.
//
// Seeding note (AGENTS.md): the purchase order is a precondition. Drafts and
// shipments are produced through the API.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const supplier = (suffix) => registerVendor(app, {
  vendorId: `vendor_draft_${suffix}`,
  companyName: `Draft Supplier ${suffix.toUpperCase()} Pvt Ltd`,
  gstin: suffix === 'a' ? '27AAAAA7771A1Z1' : '27AAAAA7772A1Z1',
  pan: suffix === 'a' ? 'AAAAA7771A' : 'AAAAA7772A',
  email: `draft-${suffix}@example.com`,
}, { onboarded: true });

const setup = async () => {
  const a = await supplier('a');
  await asTenant(() => prisma.purchaseOrder.create({
    data: {
      id: 'PO-2026-DRF1',
      vendorId: 'vendor_draft_a',
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, unitPrice: 10, netValue: 1000 }] },
    },
  }));
  expect((await request(app).put('/api/pos/PO-2026-DRF1/acknowledge').set(auth(a.token))).status).toBe(200);
  return a;
};

const complete = (overrides = {}) => ({
  invoiceReference: 'INV/26/0001',
  invoiceDate: new Date().toISOString(),
  invoiceValue: 1180,
  shipDate: new Date().toISOString(),
  estimatedDeliveryDate: new Date(Date.now() + 3 * 86400000).toISOString(),
  carrierName: 'Blue Dart',
  trackingNumber: 'LR-0001',
  items: [{ line: 10, shippedQuantity: 40 }],
  ...overrides,
});

const save = (token, body) => request(app).post('/api/asn-drafts').set(auth(token)).send(body);
const submit = (token, pk) => request(app).post(`/api/asn-drafts/${pk}/submit`).set(auth(token));

describe('saving a draft', () => {
  it('keeps half-typed values and takes no ASN number', async () => {
    const a = await setup();

    const res = await save(a.token, { poId: 'PO-2026-DRF1', step: 3, payload: { invoiceReference: 'INV 08', vehicleNumber: 'HR55' } });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ poId: 'PO-2026-DRF1', step: 3, payload: { invoiceReference: 'INV 08' } });
    expect(res.body).not.toHaveProperty('id');
    expect(await asTenant(() => prisma.aSN.count())).toBe(0);
  });

  it('replaces the form on update, so a removed line stays removed', async () => {
    const a = await setup();
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: { items: [{ line: 10, shippedQuantity: 5 }], carrierName: 'X' } });

    const res = await request(app).put(`/api/asn-drafts/${draft.body.pk}`).set(auth(a.token)).send({ step: 2, payload: { carrierName: 'Y' } });

    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({ carrierName: 'Y' });
    expect(res.body.step).toBe(2);
  });

  it('refuses a field the submit form does not have', async () => {
    const a = await setup();

    expect((await save(a.token, { payload: { notAField: 1 } })).status).toBe(400);
  });

  it('reserves no quantity: a shipment can still take the whole order', async () => {
    const a = await setup();
    await save(a.token, { poId: 'PO-2026-DRF1', payload: { items: [{ line: 10, shippedQuantity: 100 }] } });

    const res = await request(app).post('/api/pos/PO-2026-DRF1/asn').set(auth(a.token)).send(complete({ items: [{ line: 10, shippedQuantity: 100 }] }));

    expect(res.status).toBe(201);
  });

  it('is limited per supplier', async () => {
    const a = await setup();
    await asTenant(() => prisma.asnDraft.createMany({
      data: Array.from({ length: 50 }, () => ({ clientId: 'CLT-0001', vendorId: 'vendor_draft_a' })),
    }));

    expect((await save(a.token, {})).status).toBe(400);
  });
});

describe('submitting a draft', () => {
  it('becomes a shipment with an ASN number, and the draft is gone', async () => {
    const a = await setup();
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: complete() });

    const res = await submit(a.token, draft.body.pk);

    expect(res.status).toBe(201);
    expect(res.body.asn.id).toMatch(/^ASN-/);
    expect(res.body.asn.invoiceReference).toBe('INV/26/0001');
    expect((await request(app).get(`/api/asn-drafts/${draft.body.pk}`).set(auth(a.token))).status).toBe(404);
  });

  it('says what is missing, field by field, and keeps the draft', async () => {
    const a = await setup();
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: { carrierName: 'Blue Dart' } });

    const res = await submit(a.token, draft.body.pk);

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.errors)).toEqual(expect.arrayContaining(['invoiceReference', 'invoiceDate', 'invoiceValue', 'items']));
    expect((await request(app).get(`/api/asn-drafts/${draft.body.pk}`).set(auth(a.token))).status).toBe(200);
  });

  it('applies today\'s rules: quantity shipped since the draft was saved is not open any more', async () => {
    const a = await setup();
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: complete({ items: [{ line: 10, shippedQuantity: 80 }] }) });
    expect((await request(app).post('/api/pos/PO-2026-DRF1/asn').set(auth(a.token))
      .send(complete({ invoiceReference: 'INV/26/0002', items: [{ line: 10, shippedQuantity: 50 }] }))).status).toBe(201);

    const res = await submit(a.token, draft.body.pk);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/still open to ship \(50\)/);
  });

  it('makes one shipment from two simultaneous submits', async () => {
    const a = await setup();
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: complete({ items: [{ line: 10, shippedQuantity: 10 }] }) });

    const results = await Promise.all([submit(a.token, draft.body.pk), submit(a.token, draft.body.pk)]);

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await asTenant(() => prisma.aSN.count({ where: { poId: 'PO-2026-DRF1' } }))).toBe(1);
  });
});

describe('a draft across several orders', () => {
  it('names each line\'s order and submits as one shipment', async () => {
    const a = await setup();
    await asTenant(() => prisma.purchaseOrder.create({
      data: {
        id: 'PO-2026-DRF2', vendorId: 'vendor_draft_a',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-009', description: 'Washers', quantity: 20, unitPrice: 1, netValue: 20 }] },
      },
    }));
    expect((await request(app).put('/api/pos/PO-2026-DRF2/acknowledge').set(auth(a.token))).status).toBe(200);
    const draft = await save(a.token, { payload: complete({ items: [
      { poId: 'PO-2026-DRF1', line: 10, shippedQuantity: 5 },
      { poId: 'PO-2026-DRF2', line: 10, shippedQuantity: 5 },
    ] }) });

    const res = await submit(a.token, draft.body.pk);

    expect(res.status).toBe(201);
    expect(res.body.asn.items.map((item) => item.poId)).toEqual(['PO-2026-DRF1', 'PO-2026-DRF2']);
  });

  it('cannot be submitted while a line has no order', async () => {
    const a = await setup();
    const draft = await save(a.token, { payload: complete() });

    expect((await submit(a.token, draft.body.pk)).status).toBe(400);
  });
});

describe('attachments on a draft', () => {
  it('are kept by slot, and become the shipment\'s documents on submit', async () => {
    const a = await setup();
    const upload = await request(app).post('/api/uploads').set(auth(a.token))
      .field('linkedTo', 'ASN').attach('file', Buffer.from('%PDF-1.4 invoice'), 'invoice.pdf');
    const attachments = { invoiceCopy: { documentId: upload.body.documentId, originalName: 'invoice.pdf', size: 16 } };
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: complete({ attachments }) });
    expect(draft.body.payload.attachments).toEqual(attachments);

    const res = await submit(a.token, draft.body.pk);

    expect(res.status).toBe(201);
    expect(res.body.asn.documents).toEqual([expect.objectContaining({ documentId: upload.body.documentId })]);
  });
});

describe('whose drafts', () => {
  it('another supplier cannot read, change, delete or submit them', async () => {
    const a = await setup();
    const b = await supplier('b');
    const draft = await save(a.token, { poId: 'PO-2026-DRF1', payload: complete() });
    const pk = draft.body.pk;

    expect((await request(app).get(`/api/asn-drafts/${pk}`).set(auth(b.token))).status).toBe(404);
    expect((await request(app).put(`/api/asn-drafts/${pk}`).set(auth(b.token)).send({ step: 2 })).status).toBe(404);
    expect((await request(app).delete(`/api/asn-drafts/${pk}`).set(auth(b.token))).status).toBe(404);
    expect((await submit(b.token, pk)).status).toBe(404);
    expect((await request(app).get('/api/asn-drafts').set(auth(b.token))).body.drafts).toEqual([]);
  });

  it('staff cannot reach them', async () => {
    await setup();
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    expect((await request(app).get('/api/asn-drafts').set(auth(token))).status).toBe(403);
  });

  it('the owner can delete one', async () => {
    const a = await setup();
    const draft = await save(a.token, {});

    expect((await request(app).delete(`/api/asn-drafts/${draft.body.pk}`).set(auth(a.token))).status).toBe(204);
    expect((await request(app).get('/api/asn-drafts').set(auth(a.token))).body.drafts).toEqual([]);
  });
});
