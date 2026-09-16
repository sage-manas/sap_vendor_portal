const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

const app = buildTestApp();

// PUT /api/payments/:id/status reported success ("Payment status updated
// successfully") while writing nothing: `status` was never a column on
// Payment, so the handler loaded the row, spliced `status` onto the response
// in memory, and persisted nothing. See issue #56.
describe('PUT /api/payments/:id/status is gone (issue #56)', () => {
  it('no longer exists — a payment\'s state is derived from SAP clearing, not set by a user', async () => {
    const { token: vendorToken, vendor } = await registerVendor(app, {}, { onboarded: true });
    const { token: financeToken } = await createTenantUser({ role: ROLES.FINANCE });

    const payment = await asTenant(async () => {
      const po = await prisma.purchaseOrder.create({ data: { id: 'PO-2026-9900', vendorId: vendor.vendorId } });
      const invoice = await prisma.invoice.create({
        data: {
          id: 'INV-990001', poId: po.id, vendorId: vendor.vendorId,
          invoiceNumber: 'ISSUE-56/1', invoiceDate: new Date(),
          subTotal: 100, taxAmount: 0, totalAmount: 100,
          // grnId and invoicePlanRef are mutually exclusive (a CHECK
          // constraint) — this is the invoicing-plan shape, since this test
          // has no need for a full ASN→GRN chain.
          invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
        },
      });
      return prisma.payment.create({
        data: {
          id: 'PMT-990001', vendorId: vendor.vendorId,
          netAmount: 100, paymentDate: new Date(), utrCode: 'UTRTEST9900',
          items: { create: [{ clientId: 'CLT-0001', invoiceId: invoice.id, poId: po.id, netAmount: 100 }] },
        },
      });
    });

    const res = await request(app)
      .put(`/api/payments/${payment.id}/status`)
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ status: 'Cleared' });

    // The route itself is gone — a 404 from Express's own catch-all, not a
    // permission or validation refusal, and nothing about the row can have
    // changed since nothing matched a route at all.
    expect(res.status).toBe(404);

    const stored = await asTenant(() => prisma.payment.findFirst({ where: { id: payment.id } }));
    expect(stored).not.toHaveProperty('status');

    // The supplier's own read is unaffected — a route that never existed on
    // this path shouldn't touch a sibling's behaviour.
    const read = await request(app).get(`/api/payments/${payment.id}`).set('Authorization', `Bearer ${vendorToken}`);
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('status');
  });
});
