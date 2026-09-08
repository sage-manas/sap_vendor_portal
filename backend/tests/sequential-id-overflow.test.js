// controllers/rfq.controller.js's nextSequentialId() used to find "the latest
// id" with a plain string sort. That only agrees with numeric order while
// every suffix has the same digit width. Past 999 (RFQ's 3-digit padding) or
// 9999 (PO's 4-digit padding), "...-1000" sorts *before* "...-999" as a
// string ('1' < '9'), so the old code would forever compute "1000" as the next
// id, forever collide with the row already sitting there, and every RFQ/PO
// creation for that tenant would fail from that point on for the rest of the
// year. This seeds a tenant already past that boundary and proves creation
// still finds the true next number.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { asTenant, createTenantUser, registerVendor } = require('./helpers');

const app = buildTestApp();
const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const year = new Date().getFullYear();

describe('sequential id generation past its zero-padding width', () => {
  it('RFQ: finds NNNN+1 numerically, not the string-max of the existing ids', async () => {
    const buyer = await createTenantUser({ role: 'buyer' });
    const asBuyer = (req) => req.set('Authorization', `Bearer ${buyer.token}`);

    await asTenant(() => prisma.rFQ.createMany({
      data: [
        { id: `RFQ-${year}-999`, description: 'seed', deadlineDate: new Date(futureDate()) },
        { id: `RFQ-${year}-1000`, description: 'seed', deadlineDate: new Date(futureDate()) },
      ],
    }));

    const res = await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'The one after four digits',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Widget', quantity: 1, targetPrice: 1 }],
      invitedVendors: [],
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(`RFQ-${year}-1001`);
  });

  it('PurchaseOrder: same fix, exercised via a real award, past its 4-digit padding', async () => {
    const vendorId = 'vendor_po_overflow';
    const supplier = await registerVendor(app, { vendorId, email: 'po-overflow@example.com' }, { onboarded: true });
    const buyer = await createTenantUser({ role: 'buyer', email: 'buyer-po-overflow@example.com' });
    const asSupplier = (req) => req.set('Authorization', `Bearer ${supplier.token}`);
    const asBuyer = (req) => req.set('Authorization', `Bearer ${buyer.token}`);

    await asTenant(() => prisma.purchaseOrder.createMany({
      data: [
        { id: `PO-${year}-9999`, vendorId },
        { id: `PO-${year}-10000`, vendorId },
      ],
    }));

    const rfqRes = await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'Award past PO padding width',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Widget', quantity: 1, targetPrice: 1 }],
      invitedVendors: [{ id: vendorId, name: 'Supplier', rating: 90 }],
    });
    expect(rfqRes.status).toBe(201);

    const bidRes = await asSupplier(request(app).post(`/api/rfqs/${rfqRes.body.id}/bid`)).send({
      unitPrices: { 10: 1 },
      gstRate: '18%',
      deliveryLeadTimeDays: 5,
      validityDate: futureDate(30),
      freight: 0,
    });
    expect(bidRes.status).toBe(200);

    const awardRes = await asBuyer(request(app).post(`/api/rfqs/${rfqRes.body.id}/award`)).send({ vendorId });

    expect(awardRes.status).toBe(200);
    expect(awardRes.body.po.id).toBe(`PO-${year}-10001`);
  });
});
