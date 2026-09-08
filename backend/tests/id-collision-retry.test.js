// backend/utils/createWithUniqueId.js retries a create when the id it
// generated collides with an existing row — see its header for why the
// business-reference ids it wraps (INV-, ASN-, PMT-…) need this. Two layers:
// the helper itself in isolation, and one real submission path forced through
// an actual collision to prove the retry is wired correctly end to end.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { registerVendor, createTenantUser } = require('./helpers');
const { createWithUniqueId } = require('../utils/createWithUniqueId');

const { Prisma } = require('@prisma/client');

const app = buildTestApp();

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  });

describe('createWithUniqueId', () => {
  it('returns the first attempt when there is no collision', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'ok' });
    const result = await createWithUniqueId({ genId: () => 'id-1', create });
    expect(result).toEqual({ id: 'ok' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('regenerates and retries on a unique-constraint violation', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(uniqueViolation())
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ id: 'third-try' });
    const genId = jest.fn().mockReturnValueOnce('a').mockReturnValueOnce('b').mockReturnValueOnce('c');

    const result = await createWithUniqueId({ genId, create });

    expect(result).toEqual({ id: 'third-try' });
    expect(create).toHaveBeenNthCalledWith(1, 'a');
    expect(create).toHaveBeenNthCalledWith(2, 'b');
    expect(create).toHaveBeenNthCalledWith(3, 'c');
  });

  it('gives up and rethrows after exhausting its attempts', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolation());
    await expect(createWithUniqueId({ genId: () => 'x', create, attempts: 3 }))
      .rejects.toMatchObject({ code: 'P2002' });
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('does not retry a different kind of error', async () => {
    const boom = new Error('not a collision');
    const create = jest.fn().mockRejectedValue(boom);
    await expect(createWithUniqueId({ genId: () => 'x', create }))
      .rejects.toBe(boom);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('a forced id collision on invoice submission still succeeds', () => {
  it('retries with a fresh id when the generated one is already taken', async () => {
    await registerVendor(app, { clientId: 'CLT-0001', vendorId: 'vendor_collide' }, { onboarded: true });
    const buyer = await createTenantUser({ role: 'buyer', email: 'buyer-collide@example.com' });
    const supplier = await request(app)
      .post('/api/auth/login')
      .set('x-client-slug', 'legacy')
      .send({ vendorIdOrEmail: 'vendor_collide', password: 'secret123' });
    const asBuyer = (req) => req.set('Authorization', `Bearer ${buyer.token}`);
    const asSupplier = (req) => req.set('Authorization', `Bearer ${supplier.body.token}`);

    // Minimal PO → acknowledge → ASN → wait for the mock warehouse's GRN, the
    // same shape tests/lifecycle-e2e.test.js walks in full.
    const rfqRes = await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'Collision test',
      deadlineDate: new Date(Date.now() + 7 * 86400000).toISOString(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Widget', quantity: 10, targetPrice: 5 }],
      invitedVendors: [{ id: 'vendor_collide', name: 'Supplier', rating: 90 }],
    });
    const bidRes = await asSupplier(request(app).post(`/api/rfqs/${rfqRes.body.id}/bid`)).send({
      unitPrices: { 10: 5 }, gstRate: '18%', deliveryLeadTimeDays: 5,
      validityDate: new Date(Date.now() + 30 * 86400000).toISOString(), freight: 0,
    });
    expect(bidRes.status).toBe(200);
    const awardRes = await asBuyer(request(app).post(`/api/rfqs/${rfqRes.body.id}/award`)).send({ vendorId: 'vendor_collide' });
    const poId = awardRes.body.po.id;
    await asSupplier(request(app).put(`/api/pos/${poId}/acknowledge`));
    const asnRes = await asSupplier(request(app).post(`/api/pos/${poId}/asn`)).send({
      shipDate: new Date().toISOString(),
      estimatedDeliveryDate: new Date(Date.now() + 2 * 86400000).toISOString(),
      items: [{ line: 10, shippedQuantity: 10 }],
    });
    expect(asnRes.status).toBe(201);

    let grn = null;
    for (let i = 0; i < 50 && !grn; i += 1) {
      const res = await asSupplier(request(app).get('/api/grns'));
      grn = (res.body.grns || res.body || []).find((g) => g.poId === poId);
      if (!grn) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(grn).toBeTruthy();

    // The id the very next Math.random() draw would produce for the invoice —
    // computed the same way genInvoiceId does — pre-occupied by another row
    // in this tenant, so the real submission below must collide on its first
    // attempt.
    const nextRandom = Math.random();
    const collidingId = 'INV-' + Math.floor(100000 + nextRandom * 900000);
    await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: collidingId,
        // grnId and invoicePlanRef are a discriminated union at the database
        // level (append_only_and_checks migration) — exactly one must be set.
        // Reusing the real GRN's id is fine: this row is inserted directly,
        // bypassing the controller's invoiceSubmitted flag entirely, so the
        // real submission below still sees that GRN as not yet invoiced.
        grnId: grn.id,
        poId,
        vendorId: 'vendor_collide',
        invoiceNumber: 'PRE-EXISTING',
        invoiceDate: new Date(),
        subTotal: 1, taxAmount: 0, totalAmount: 1,
      },
    }));

    // A distinct fractional value, computed before the spy exists so this
    // doesn't call the mocked Math.random recursively. Just needs to floor to
    // a different 6-digit suffix than nextRandom did.
    const otherRandom = (nextRandom + 0.37) % 1;
    const randomSpy = jest.spyOn(Math, 'random')
      .mockReturnValueOnce(nextRandom) // first attempt: same id as above → P2002
      .mockReturnValue(otherRandom); // every retry after: a different draw

    try {
      const invoiceRes = await asSupplier(request(app).post('/api/invoices')).send({
        grnId: grn.id,
        invoiceNumber: 'INV-collide-001',
        invoiceDate: new Date().toISOString(),
        subTotal: 50, taxAmount: 9, totalAmount: 59,
        items: [{ line: 10, materialCode: 'MAT-001', description: 'Widget', quantity: 10, unitPrice: 5, amount: 50 }],
      });

      expect(invoiceRes.status).toBe(201);
      expect(invoiceRes.body.invoice.id).not.toBe(collidingId);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
