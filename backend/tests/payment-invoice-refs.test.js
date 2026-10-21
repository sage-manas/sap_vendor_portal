// Issue #282: #63 moved the settled invoice off the Payment header onto
// PaymentItem, so a payment's API responses stopped carrying any invoice
// reference at all — and every screen still reading `invoiceNumber`/
// `invoiceId`/`invoiceRef` off the header showed a permanently blank Invoice
// column. `formatPayment` now derives `invoiceRefs` from the items, which is
// what those screens render.
//
// Exercised through the API, end to end: a remittance settling two invoices
// is recorded by a finance user through POST /api/payments (the route that
// accepts the same multi-item shape the SAP discovery paths produce) and read
// back by the supplier it paid. A supplier cannot record a payment against
// itself — payment:create is tenant-staff only — so the two planes are split
// the way they are in the app.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

const app = buildTestApp();

const seedInvoice = (vendorId, { poId, invoiceId, invoiceNumber, totalAmount }) => asTenant(async () => {
  const po = await prisma.purchaseOrder.upsert({
    where: { clientId_id: { clientId: 'CLT-0001', id: poId } },
    create: { id: poId, vendorId, status: 'Invoiced' },
    update: {},
  });
  await prisma.invoice.create({
    data: {
      id: invoiceId, poId: po.id, vendorId, invoiceNumber, invoiceDate: new Date(),
      status: 'Submitted', subTotal: totalAmount, taxAmount: 0, totalAmount,
      invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
    },
  });
  return { poId: po.id, invoiceId, invoiceNumber };
});

describe('a payment names the invoices it settled (issue #282)', () => {
  it('returns invoiceRefs for a two-item payment, from create and both reads', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    const { token: financeToken } = await createTenantUser({ role: ROLES.FINANCE });
    const first = await seedInvoice(vendor.vendorId, {
      poId: 'PO-REFS-1', invoiceId: 'INV-REFS-1', invoiceNumber: 'REFS/2026/001', totalAmount: 1000,
    });
    const second = await seedInvoice(vendor.vendorId, {
      poId: 'PO-REFS-2', invoiceId: 'INV-REFS-2', invoiceNumber: 'REFS/2026/002', totalAmount: 500,
    });

    const created = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({
        id: 'PMT-REFS-1',
        vendorId: vendor.vendorId,
        paymentDate: new Date().toISOString(),
        utrCode: 'UTRREFS0001',
        paymentMethod: 'NEFT',
        items: [
          { poId: first.poId, invoiceId: first.invoiceId, invoiceNumber: first.invoiceNumber, grossAmount: 1000, tdsDeducted: 100, netAmount: 900 },
          { poId: second.poId, invoiceId: second.invoiceId, invoiceNumber: second.invoiceNumber, grossAmount: 500, tdsDeducted: 50, netAmount: 450 },
        ],
      });

    expect(created.status).toBe(201);
    // Both invoices, in item order, by their human-readable numbers — the
    // reference a supplier reconciles against, not the internal id.
    expect(created.body.invoiceRefs).toEqual(['REFS/2026/001', 'REFS/2026/002']);

    const byId = await request(app).get('/api/payments/PMT-REFS-1').set('Authorization', `Bearer ${token}`);
    expect(byId.status).toBe(200);
    expect(byId.body.invoiceRefs).toEqual(['REFS/2026/001', 'REFS/2026/002']);

    const list = await request(app).get('/api/payments?limit=50').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const listed = list.body.payments.find((p) => p.id === 'PMT-REFS-1');
    expect(listed.invoiceRefs).toEqual(['REFS/2026/001', 'REFS/2026/002']);
  });

  it('falls back to the invoice id when SAP supplied no invoice number', async () => {
    const { vendor } = await registerVendor(app, {}, { onboarded: true });
    const { token: financeToken } = await createTenantUser({ role: ROLES.FINANCE });
    const only = await seedInvoice(vendor.vendorId, {
      poId: 'PO-REFS-3', invoiceId: 'INV-REFS-3', invoiceNumber: 'REFS/2026/003', totalAmount: 250,
    });

    const created = await request(app)
      .post('/api/payments')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({
        id: 'PMT-REFS-2',
        vendorId: vendor.vendorId,
        paymentDate: new Date().toISOString(),
        utrCode: 'UTRREFS0002',
        // No invoiceNumber on the item: the two SAP-discovery paths pass
        // through whatever SAP named, and it can be absent.
        items: [{ poId: only.poId, invoiceId: only.invoiceId, grossAmount: 250, tdsDeducted: 0, netAmount: 250 }],
      });

    expect(created.status).toBe(201);
    expect(created.body.invoiceRefs).toEqual(['INV-REFS-3']);
  });
});
