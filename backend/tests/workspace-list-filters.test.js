const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, createAdminUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');
const { INVOICE_STATUS, INVOICE_OPEN, PO_AWAITING_SUPPLIER } = require('../config/statuses');

// Issue #281. The four workspace lists asked for a fixed `limit: 200` and
// rendered the answer, so past 200 rows finance read an incomplete list that
// looked complete. The screens page now, and they filter server-side — which
// is the part that has to be true in the API for the fix to mean anything:
//
//   - `pagination.total` counts the FILTERED set, not the table. A count that
//     ignores the filter is the same defect in a new place: the reader is
//     shown a number that does not describe what they are looking at.
//   - `?view=open` means what the overview's own tiles count, so a tile and
//     the list it links to state the same number. The groups come from the
//     status registry (config/statuses.js) precisely so the two cannot drift.
//   - Neither filter can widen a supplier's scope.
//
// The ceiling on `limit` is not retested here: validators/pagination.validator.js
// owns it and tests/pagination-route-table.test.js asserts it on every
// paginated route.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const soon = () => new Date(Date.now() + 86400000);

// One invoice per status the registry knows, so "not yet cleared" is a claim
// about a set and not about a single row.
const seedInvoicePerStatus = (vendorId) => asTenant(async () => {
  await prisma.purchaseOrder.create({ data: { id: 'PO-2026-F01', vendorId } });
  let n = 0;
  for (const status of Object.values(INVOICE_STATUS)) {
    n += 1;
    await prisma.invoice.create({
      data: {
        id: `INV-F${n}`, poId: 'PO-2026-F01', vendorId, status,
        invoiceNumber: `INV/F/${n}`,
        // A month apart, newest last, so a date range can cut the set.
        invoiceDate: new Date(Date.UTC(2026, n, 15)),
        subTotal: 100 * n, taxAmount: 0, totalAmount: 100 * n,
        invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
      },
    });
  }
});

describe('GET /api/invoices, filtered for the workspace list', () => {
  let token;
  let vendorId;

  beforeEach(async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_f1', gstin: '27AAAAA9111A1Z1' }, { onboarded: true });
    vendorId = vendor.vendorId;
    await seedInvoicePerStatus(vendorId);
    token = (await createTenantUser({ role: ROLES.FINANCE })).token;
  });

  it('?view=open returns exactly the statuses the overview counts as open', async () => {
    const res = await request(app).get('/api/invoices?view=open&limit=100').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.invoices.map((invoice) => invoice.status).sort()).toEqual([...INVOICE_OPEN].sort());
  });

  it('?view=open excludes a rejected invoice — a rejection is a decision, not money owed', async () => {
    const res = await request(app).get('/api/invoices?view=open&limit=100').set(auth(token));

    expect(res.body.invoices.map((invoice) => invoice.status)).not.toContain(INVOICE_STATUS.REJECTED);
  });

  it('counts the filtered set in pagination.total, not the whole table', async () => {
    const all = await request(app).get('/api/invoices?limit=100').set(auth(token));
    const open = await request(app).get('/api/invoices?view=open&limit=100').set(auth(token));

    expect(all.body.pagination.total).toBe(Object.values(INVOICE_STATUS).length);
    expect(open.body.pagination.total).toBe(INVOICE_OPEN.length);
    // The caption the list renders reads off this number, so a total that
    // ignored the filter would print "Showing 1–5 of 7" over five rows.
    expect(open.body.pagination.total).toBe(open.body.invoices.length);
  });

  it('?status= takes one literal value, and a comma-separated set', async () => {
    const one = await request(app).get('/api/invoices?status=Cleared&limit=100').set(auth(token));
    expect(one.body.invoices.map((invoice) => invoice.status)).toEqual([INVOICE_STATUS.CLEARED]);

    const two = await request(app).get('/api/invoices?status=Cleared,Rejected&limit=100').set(auth(token));
    expect(two.body.invoices.map((invoice) => invoice.status).sort())
      .toEqual([INVOICE_STATUS.CLEARED, INVOICE_STATUS.REJECTED].sort());
    expect(two.body.pagination.total).toBe(2);
  });

  it('?minAmount= narrows to the invoices at or above the review amount', async () => {
    const res = await request(app).get('/api/invoices?minAmount=500&limit=100').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.invoices.length).toBeGreaterThan(0);
    for (const invoice of res.body.invoices) {
      expect(Number(invoice.totalAmount)).toBeGreaterThanOrEqual(500);
    }
  });

  it('?from/?to narrow by invoice date, inclusive of the day `to` names', async () => {
    // Seeded at the 15th of months 1..7 of 2026 (UTC).
    const res = await request(app)
      .get('/api/invoices?from=2026-03-01&to=2026-04-15&limit=100')
      .set(auth(token));

    expect(res.status).toBe(200);
    const dates = res.body.invoices.map((invoice) => invoice.invoiceDate.slice(0, 10)).sort();
    expect(dates).toEqual(['2026-03-15', '2026-04-15']);
  });

  it('ignores an unparseable date rather than failing the request', async () => {
    const res = await request(app).get('/api/invoices?from=last-tuesday&limit=100').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(Object.values(INVOICE_STATUS).length);
  });

  it('cannot widen a supplier past their own invoices', async () => {
    const other = await registerVendor(
      app,
      { vendorId: 'vendor_f2', gstin: '27AAAAA9112A1Z1', email: 'f2@example.com' },
      { onboarded: true },
    );

    // The other supplier asks for the first supplier's rows by name.
    const res = await request(app)
      .get(`/api/invoices?vendorId=${vendorId}&limit=100`)
      .set(auth(other.token));

    expect(res.status).toBe(200);
    for (const invoice of res.body.invoices) {
      expect(invoice.vendorId).toBe(other.vendor.vendorId);
    }
  });
});

describe('GET /api/pos, filtered for the workspace list', () => {
  it('?view=open returns exactly the statuses the overview counts as open', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_p1', gstin: '27AAAAA9113A1Z1' }, { onboarded: true });
    await asTenant(async () => {
      let n = 0;
      for (const status of ['Open', 'Acknowledged', 'Dispatched', 'Delivered', 'Invoiced', 'Paid']) {
        n += 1;
        await prisma.purchaseOrder.create({ data: { id: `PO-2026-P${n}`, vendorId: vendor.vendorId, status } });
      }
    });
    const { token } = await createTenantUser({ role: ROLES.BUYER });

    const res = await request(app).get('/api/pos?view=open&limit=100').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.pos.map((po) => po.status).sort()).toEqual([...PO_AWAITING_SUPPLIER].sort());
    expect(res.body.pagination.total).toBe(PO_AWAITING_SUPPLIER.length);
  });
});

describe('GET /api/rfqs, filtered for the workspace list', () => {
  it('?status= narrows, and the total counts the narrowed set', async () => {
    await asTenant(async () => {
      await prisma.rFQ.create({ data: { id: 'RFQ-2026-S1', description: 'Open one', status: 'Bidding Open', deadlineDate: soon() } });
      await prisma.rFQ.create({ data: { id: 'RFQ-2026-S2', description: 'Awarded one', status: 'Awarded', deadlineDate: soon() } });
      await prisma.rFQ.create({ data: { id: 'RFQ-2026-S3', description: 'Another open one', status: 'Bidding Open', deadlineDate: soon() } });
    });
    const { token } = await createAdminUser();

    const res = await request(app).get('/api/rfqs?all=true&status=Bidding Open&limit=100').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.rfqs.map((rfq) => rfq.id).sort()).toEqual(['RFQ-2026-S1', 'RFQ-2026-S3']);
    expect(res.body.pagination.total).toBe(2);
  });

  it('a status filter does not let a supplier see an RFQ they were not invited to', async () => {
    const { token } = await registerVendor(app, { vendorId: 'vendor_r1', gstin: '27AAAAA9114A1Z1' }, { onboarded: true });
    await asTenant(async () => {
      await prisma.rFQ.create({ data: { id: 'RFQ-2026-R9', description: 'Not theirs', status: 'Bidding Open', deadlineDate: soon() } });
    });

    const res = await request(app).get('/api/rfqs?status=Bidding Open&all=true&limit=100').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.rfqs.map((rfq) => rfq.id)).not.toContain('RFQ-2026-R9');
  });
});

describe('GET /api/payments, filtered for the workspace list', () => {
  it('?from/?to narrow by payment date, and the total follows', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_y1', gstin: '27AAAAA9115A1Z1' }, { onboarded: true });
    await asTenant(async () => {
      for (const [suffix, month] of [['Y1', 1], ['Y2', 5], ['Y3', 9]]) {
        await prisma.payment.create({
          data: {
            id: `PMT-${suffix}`, vendorId: vendor.vendorId,
            netAmount: 100, grossAmount: 100, tdsDeducted: 0,
            paymentDate: new Date(Date.UTC(2026, month, 10)), utrCode: `UTR-${suffix}`,
          },
        });
      }
    });
    const { token } = await createTenantUser({ role: ROLES.FINANCE });

    const res = await request(app)
      .get('/api/payments?from=2026-05-01&to=2026-06-30&limit=100')
      .set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.payments.map((payment) => payment.id)).toEqual(['PMT-Y2']);
    expect(res.body.pagination.total).toBe(1);
  });
});

describe('a page past the first is reachable, and the total stays the true total', () => {
  it('serves page 2 of a set larger than the page size', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_g1', gstin: '27AAAAA9116A1Z1' }, { onboarded: true });
    await asTenant(async () => {
      for (let n = 1; n <= 7; n += 1) {
        await prisma.purchaseOrder.create({ data: { id: `PO-2026-G${n}`, vendorId: vendor.vendorId } });
      }
    });
    const { token } = await createTenantUser({ role: ROLES.BUYER });

    const first = await request(app).get('/api/pos?page=1&limit=5').set(auth(token));
    const second = await request(app).get('/api/pos?page=2&limit=5').set(auth(token));

    expect(first.body.pos).toHaveLength(5);
    expect(second.body.pos).toHaveLength(2);
    // The whole point: both pages report seven, so the screen can say
    // "Showing 6–7 of 7" rather than presenting two rows as the list.
    expect(first.body.pagination.total).toBe(7);
    expect(second.body.pagination.total).toBe(7);
    expect(second.body.pagination.pages).toBe(2);

    const ids = [...first.body.pos, ...second.body.pos].map((po) => po.id);
    expect(new Set(ids).size).toBe(7);
  });
});
