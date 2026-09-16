// Issue #71: GET /api/invoices/sap-status used to pull a supplier's whole
// invoice history with no cap, then issue one invoicePaymentDetail call per
// matched invoice in a single unbounded Promise.all — 80 matched invoices,
// 80 simultaneous requests to the customer's own SAP gateway from one page
// load, enough to trip the circuit breaker for the whole tenant.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant } = require('./helpers');
const { getSapAdapterForClient, invalidateSapAdapter } = require('../sap');

const app = buildTestApp();

// The mock driver's vendorMiroDisplay echoes `poNumber: invoice.poId`
// (mock.driver.js — it has direct access to the invoice, unlike a real
// system) rather than the PO's own SAP number, so a PO's sapPoNumber has to
// equal its portal id for sap/mappings/invoice-match.js's PO+amount match to
// succeed against the mock. Real matching against s4_odata is covered by
// tests/invoice-match.test.js; this file is about the fan-out, not the
// matching itself.
const seedPo = (id, vendorId) => asTenant(() => prisma.purchaseOrder.create({
  data: { id, sapPoNumber: id, vendorId, buyerName: 'Test Buyer', status: 'Invoiced' },
}));

const seedInvoice = (n, { vendorId, poId, totalAmount = 1000, sapMiroDoc } = {}) => asTenant(() => prisma.invoice.create({
  data: {
    id: `INV-9${String(n).padStart(5, '0')}`,
    poId,
    vendorId,
    invoiceNumber: `SUP-INV-${n}`,
    invoiceDate: new Date('2026-01-10'),
    subTotal: totalAmount,
    taxAmount: 0,
    totalAmount,
    sapMiroDoc,
    invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
  },
}));

beforeEach(() => invalidateSapAdapter());

describe('GET /api/invoices/sap-status pagination (issue #71)', () => {
  it('defaults to 10 invoices per page, matching GET /api/invoices', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_1', gstin: '27AAAAA0011A1Z1' }, { onboarded: true });
    const po = await seedPo('PO-2026-9101', vendor.vendorId);
    await Promise.all(Array.from({ length: 15 }, (_, i) => seedInvoice(i, { vendorId: vendor.vendorId, poId: po.id })));

    const res = await request(app).get('/api/invoices/sap-status').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ total: 15, page: 1, limit: 10, pages: 2 });
    expect(res.body.documents).toHaveLength(10);
  });

  it('honours an explicit page/limit', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_2', gstin: '27AAAAA0012A1Z1' }, { onboarded: true });
    const po = await seedPo('PO-2026-9102', vendor.vendorId);
    await Promise.all(Array.from({ length: 15 }, (_, i) => seedInvoice(i, { vendorId: vendor.vendorId, poId: po.id })));

    const res = await request(app).get('/api/invoices/sap-status?page=2&limit=5').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ total: 15, page: 2, limit: 5, pages: 3 });
    expect(res.body.documents).toHaveLength(5);
  });

  it('caps an absurd limit rather than letting it re-open the unbounded fan-out', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_3', gstin: '27AAAAA0013A1Z1' }, { onboarded: true });
    const po = await seedPo('PO-2026-9103', vendor.vendorId);
    await Promise.all(Array.from({ length: 5 }, (_, i) => seedInvoice(i, { vendorId: vendor.vendorId, poId: po.id })));

    const res = await request(app).get('/api/invoices/sap-status?limit=100000').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });
});

describe('GET /api/invoices/sap-status payment-detail reuse (issue #71)', () => {
  it('reads a cleared invoice\'s payment detail from the local Payment record, not from SAP again', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_4', gstin: '27AAAAA0014A1Z1' }, { onboarded: true });
    const po = await seedPo('PO-2026-9104', vendor.vendorId);

    // The mock echoes back whatever sapMiroDoc the invoice already carries
    // (mock.driver.js's vendorMiroDisplay: `miroDoc: invoice.sapMiroDoc || mockMiroDoc(invoice)`),
    // so this value only has to be stable, not shaped like a real SAP number.
    const clearedMiroDoc = 'MIRO-CLEARED-1';
    const cleared = await seedInvoice(1, { vendorId: vendor.vendorId, poId: po.id, sapMiroDoc: clearedMiroDoc });
    await asTenant(() => prisma.payment.create({
      data: {
        id: 'PMT-SAPSTATUS-1', vendorId: vendor.vendorId,
        paymentDate: new Date('2026-02-01'),
        sapPaymentDoc: 'PAY-0001',
        utrCode: 'UTR12345',
        paymentMethod: 'NEFT',
        grossAmount: 1000, tdsDeducted: 20, netAmount: 980,
        items: { create: [{ clientId: 'CLT-0001', invoiceId: cleared.id, poId: po.id, invoiceNumber: cleared.invoiceNumber, grossAmount: 1000, tdsDeducted: 20, netAmount: 980 }] },
      },
    }));

    // A different amount than `cleared` — same PO and date would otherwise
    // give matchInvoiceDocument two equally-good candidates and it would
    // (correctly) refuse to guess between them.
    const notYetCleared = await seedInvoice(2, { vendorId: vendor.vendorId, poId: po.id, totalAmount: 2500 });

    // Pre-warm and spy on the cached adapter the controller will reuse.
    const adapter = await getSapAdapterForClient('CLT-0001');
    const spy = jest.spyOn(adapter, 'invoicePaymentDetail');

    const res = await request(app).get('/api/invoices/sap-status').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.paymentDetails[clearedMiroDoc]).toMatchObject({
      found: true, status: 'CLEARED', grossAmount: 1000, tdsDeducted: 20, netDisbursed: 980,
      clearingDocument: 'PAY-0001', utrReference: 'UTR12345', paymentMethod: 'NEFT',
    });

    // Only the not-yet-cleared invoice needed a live read — the cleared one's
    // detail came from PaymentItem instead.
    expect(spy).toHaveBeenCalledTimes(1);
    const notYetClearedDoc = spy.mock.calls[0][0];
    expect(notYetClearedDoc.invoiceDocNo).not.toBe(clearedMiroDoc);
    void notYetCleared;

    spy.mockRestore();
  });

  it('bounds concurrent invoicePaymentDetail calls to SAP_DETAIL_CONCURRENCY', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_5', gstin: '27AAAAA0015A1Z1' }, { onboarded: true });
    const po = await seedPo('PO-2026-9105', vendor.vendorId);
    // Eight invoices, none locally cleared, each its own amount so
    // matchInvoiceDocument doesn't see same-PO/same-date/same-amount
    // siblings and (correctly) refuse to disambiguate them.
    await Promise.all(Array.from({ length: 8 }, (_, i) => seedInvoice(i, { vendorId: vendor.vendorId, poId: po.id, totalAmount: 1000 + i * 100 })));

    const adapter = await getSapAdapterForClient('CLT-0001');
    let current = 0;
    let max = 0;
    const original = adapter.invoicePaymentDetail.bind(adapter);
    jest.spyOn(adapter, 'invoicePaymentDetail').mockImplementation(async (...args) => {
      current += 1;
      max = Math.max(max, current);
      await new Promise((resolve) => setTimeout(resolve, 15));
      current -= 1;
      return original(...args);
    });

    const res = await request(app).get('/api/invoices/sap-status?limit=8').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(max).toBeLessThanOrEqual(5); // SAP_DETAIL_CONCURRENCY in invoice.controller.js
    expect(max).toBeGreaterThan(1); // proves the pool actually ran calls concurrently, not one at a time

    adapter.invoicePaymentDetail.mockRestore();
  });
});
