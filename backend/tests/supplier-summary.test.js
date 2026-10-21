const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createAdminUser } = require('./helpers');
const { runWithTenant } = require('../utils/tenantContext');
const {
  INVOICE_STATUS, INVOICE_OPEN,
  PO_STATUSES, PO_AWAITING_SUPPLIER, PO_NOT_INVOICED, PO_CLOSED,
} = require('../config/statuses');

const app = buildTestApp();
const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);

// Issue #280. GET /api/dashboard/summary is the source of every headline
// figure on the supplier's Overview and Reports screens, because computing
// them in the browser meant computing them over one page of each list
// endpoint — twenty rows — with nothing on screen saying so.
//
// The number that matters here is 25: more documents of each kind than fit
// in a page, so a figure derived from a page and a figure derived from the
// whole set are different numbers. Every assertion compares the endpoint's
// answer against a direct Prisma aggregate over the same rows, rather than
// against a constant computed by hand — a constant would only prove this
// test and the endpoint agree about 25 rows, not that the endpoint aggregates
// what is there.
//
// The documents themselves are seeded through Prisma. Per AGENTS.md that is
// the normal case, not the defect case: they are *preconditions* — this test
// exercises the aggregation, not the RFQ → award → ASN → GRN → invoice →
// payment pipeline that produces them (lifecycle-e2e.test.js owns that), and
// no API gap is being worked around. The one thing seeded state must not do
// is be unreachable through the API, and every row below is an ordinary one.

const VENDOR = 'vendor_summary_1';
const CLIENT = 'CLT-0001';
const COUNT = 25;

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days) => new Date(Date.now() - days * DAY_MS);

// Spread across statuses, ages, materials and plants, so a figure that
// ignores one of those dimensions is visibly wrong rather than coincidentally
// right. Deterministic — no Math.random in a fixture whose numbers are the
// assertion.
// Every status in the enum, Paid included (issue #288): a KPI documented as
// covering a group can only be checked against that group if the fixture has
// orders both inside and outside it.
const PO_STATUS_CYCLE = PO_STATUSES;
const INVOICE_STATUS_CYCLE = [
  INVOICE_STATUS.SUBMITTED,
  INVOICE_STATUS.UNDER_REVIEW,
  INVOICE_STATUS.MATCH_WARNING,
  INVOICE_STATUS.REJECTED,
  INVOICE_STATUS.CLEARED,
];

const seed = () => runWithTenant(CLIENT, async () => {
  for (let i = 0; i < COUNT; i++) {
    const po = await prisma.purchaseOrder.create({
      data: {
        id: `PO-SUM-${String(i).padStart(4, '0')}`,
        vendorId: VENDOR,
        status: PO_STATUS_CYCLE[i % PO_STATUS_CYCLE.length],
        createdDate: daysAgo(300 - i * 10),
        acknowledgedAt: i % 2 === 0 ? daysAgo(300 - i * 10 - 2) : null,
        items: {
          create: [
            {
              clientId: CLIENT, line: 10,
              materialCode: `MAT-${i % 4}`, description: `Material ${i % 4}`,
              quantity: 10, unitPrice: 100 + i, netValue: (100 + i) * 10,
              plant: `P10${i % 3}`,
            },
            {
              clientId: CLIENT, line: 20,
              materialCode: `MAT-${(i + 1) % 4}`, description: `Material ${(i + 1) % 4}`,
              quantity: 2, unitPrice: 50, netValue: 100,
              plant: `P10${(i + 1) % 3}`,
            },
          ],
        },
      },
    });

    const grn = await prisma.gRN.create({
      data: {
        id: `GRN-SUM-${String(i).padStart(4, '0')}`,
        poId: po.id, vendorId: VENDOR, postingDate: daysAgo(200 - i * 5),
        // A third of them still owe an invoice.
        invoiceSubmitted: i % 3 !== 0,
        items: {
          create: [{
            clientId: CLIENT, line: 1, materialCode: `MAT-${i % 4}`,
            receivedQuantity: 10, acceptedQuantity: 9, rejectedQuantity: 1,
          }],
        },
      },
    });

    const invoice = await prisma.invoice.create({
      data: {
        id: `INV-SUM-${String(i).padStart(4, '0')}`,
        // Against the receipt, not an invoicing-plan date — the schema's
        // `invoice_grn_xor_plan_ref` CHECK wants exactly one of the two.
        grnId: grn.id,
        poId: po.id, vendorId: VENDOR,
        invoiceNumber: `S/${i}`,
        invoiceDate: daysAgo(150 - i * 5),
        status: INVOICE_STATUS_CYCLE[i % INVOICE_STATUS_CYCLE.length],
        subTotal: 1000 + i * 10, taxAmount: 180 + i, totalAmount: 1180 + i * 11,
      },
    });

    // Every fifth invoice is part-settled while still open — the case that
    // makes "outstanding" different from "total" (issue #283).
    if (i % 5 === 1) {
      await prisma.payment.create({
        data: {
          id: `PMT-SUM-${String(i).padStart(4, '0')}`,
          vendorId: VENDOR, paymentDate: daysAgo(100 - i * 3),
          utrCode: `UTRSUM${i}`, sapPaymentDoc: `CLR${i}`,
          grossAmount: 500, tdsDeducted: 50, netAmount: 450, totalTds: 50,
          items: {
            create: [{
              clientId: CLIENT, invoiceId: invoice.id, poId: po.id,
              invoiceNumber: invoice.invoiceNumber,
              grossAmount: 500, tdsDeducted: 50, netAmount: 450,
            }],
          },
        },
      });
    }
  }
});

// The aggregates the endpoint is measured against, read straight from the
// database rather than recomputed in JS from a findMany — the point is that
// the figure is the database's answer, not a page's.
const expected = () => runWithTenant(CLIENT, async () => {
  const where = { vendorId: VENDOR };
  const [poCount, poValue, notInvoicedValue, grnTotal, grnAwaiting, grnQty,
    invoiceCount, invoiceTax, paymentTotals, openInvoices] = await Promise.all([
    prisma.purchaseOrder.count({ where }),
    prisma.purchaseOrderItem.aggregate({ where: { po: where }, _sum: { netValue: true } }),
    prisma.purchaseOrderItem.aggregate({
      where: { po: { ...where, status: { in: PO_NOT_INVOICED } } }, _sum: { netValue: true },
    }),
    prisma.gRN.count({ where }),
    prisma.gRN.count({ where: { ...where, invoiceSubmitted: false } }),
    prisma.grnItem.aggregate({
      where: { grn: where }, _sum: { receivedQuantity: true, acceptedQuantity: true },
    }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({ where, _sum: { taxAmount: true } }),
    prisma.payment.aggregate({
      where, _count: { _all: true }, _sum: { grossAmount: true, netAmount: true, tdsDeducted: true },
    }),
    prisma.invoice.findMany({
      where: { ...where, status: { in: INVOICE_OPEN } },
      select: { totalAmount: true, paymentItems: { select: { grossAmount: true } } },
    }),
  ]);

  const openValue = openInvoices.reduce((sum, invoice) => {
    const paid = invoice.paymentItems.reduce((total, item) => total + Number(item.grossAmount || 0), 0);
    return sum + Math.max(Number(invoice.totalAmount) - paid, 0);
  }, 0);

  return {
    poCount,
    poValue: Number(poValue._sum.netValue),
    notInvoicedValue: Number(notInvoicedValue._sum.netValue),
    grnTotal,
    grnAwaiting,
    receivedQuantity: Number(grnQty._sum.receivedQuantity),
    acceptedQuantity: Number(grnQty._sum.acceptedQuantity),
    invoiceCount,
    invoiceTax: Number(invoiceTax._sum.taxAmount),
    paymentCount: paymentTotals._count._all,
    grossTotal: Number(paymentTotals._sum.grossAmount),
    netTotal: Number(paymentTotals._sum.netAmount),
    tdsTotal: Number(paymentTotals._sum.tdsDeducted),
    openCount: openInvoices.length,
    openValue,
  };
});

describe('GET /api/dashboard/summary over more documents than fit in a page', () => {
  let supplier;
  let db;

  beforeEach(async () => {
    supplier = await registerVendor(app, { vendorId: VENDOR, gstin: '27AAAAA9280A1Z1' }, { onboarded: true });
    await seed();
    db = await expected();
  });

  const summary = async () => {
    const res = await auth(supplier.token)(request(app).get('/api/dashboard/summary'));
    expect(res.status).toBe(200);
    return res.body;
  };

  it('seeded more of each document than one page holds, or this suite proves nothing', () => {
    // The default page is 20 (validators/pagination.validator.js). If this
    // ever stops being true, every assertion below could pass on a figure
    // computed from a single page.
    expect(db.poCount).toBeGreaterThan(20);
    expect(db.invoiceCount).toBeGreaterThan(20);
    expect(db.grnTotal).toBeGreaterThan(20);
  });

  it('counts purchase orders and sums their value over every order', async () => {
    const body = await summary();

    expect(body.pos.total).toBe(db.poCount);
    expect(body.pos.totalValue).toBeCloseTo(db.poValue, 2);
    expect(body.pos.notInvoicedValue).toBeCloseTo(db.notInvoicedValue, 2);
    // Status counts add up to the total, so none is silently dropped.
    expect(Object.values(body.pos.byStatus).reduce((sum, n) => sum + n, 0)).toBe(db.poCount);
  });

  // Issue #288's acceptance criterion, as arithmetic: each KPI equals the sum
  // of its documented group's statuses — not a neighbouring group's, and not
  // "every order that isn't finished", which is how the two screens drifted
  // into showing one supplier two different "Open orders" numbers.
  it('counts each order KPI over exactly the statuses its group documents', async () => {
    const { byStatus, awaitingSupplierCount, notInvoicedCount, total } = (await summary()).pos;
    const sum = (statuses) => statuses.reduce((n, status) => n + byStatus[status], 0);

    // The fixture has to cover both groups, or the equalities below hold
    // trivially and prove nothing.
    expect(sum(PO_AWAITING_SUPPLIER)).toBeGreaterThan(0);
    expect(sum(PO_CLOSED)).toBeGreaterThan(0);
    expect(notInvoicedCount).toBeGreaterThan(awaitingSupplierCount);

    expect(awaitingSupplierCount).toBe(sum(PO_AWAITING_SUPPLIER));
    expect(notInvoicedCount).toBe(sum(PO_NOT_INVOICED));
    // The groups partition the enum, so the two sides account for every order.
    expect(notInvoicedCount + sum(PO_CLOSED)).toBe(total);
  });

  it('breaks order value down by month, material and plant without losing any of it', async () => {
    const body = await summary();
    const total = (rows) => rows.reduce((sum, row) => sum + row.value, 0);

    expect(total(body.pos.byMonth)).toBeCloseTo(db.poValue, 2);
    expect(total(body.pos.byMaterial)).toBeCloseTo(db.poValue, 2);
    expect(total(body.pos.byPlant)).toBeCloseTo(db.poValue, 2);

    // Four materials and three plants across 25 orders, every one of them
    // represented — a breakdown computed from a page would be missing some.
    expect(body.pos.byMaterial.map((row) => row.code).sort())
      .toEqual(['MAT-0', 'MAT-1', 'MAT-2', 'MAT-3']);
    expect(body.pos.byPlant.map((row) => row.plant).sort())
      .toEqual(['P100', 'P101', 'P102']);
    // Months with no orders are present as real zeroes, not skipped: the
    // orders span 250 days, so there are more months than orders-per-month.
    expect(body.pos.byMonth.length).toBeGreaterThan(5);
  });

  it('counts goods receipts awaiting an invoice, and sums receipt quantities', async () => {
    const body = await summary();

    expect(body.grns.total).toBe(db.grnTotal);
    expect(body.grns.awaitingInvoice).toBe(db.grnAwaiting);
    expect(body.grns.receivedQuantity).toBeCloseTo(db.receivedQuantity, 3);
    expect(body.grns.acceptedQuantity).toBeCloseTo(db.acceptedQuantity, 3);
  });

  it('counts invoices and sums tax over every invoice', async () => {
    const body = await summary();

    expect(body.invoices.total).toBe(db.invoiceCount);
    expect(body.invoices.taxTotal).toBeCloseTo(db.invoiceTax, 2);
  });

  it('sums payments, TDS included, over every payment', async () => {
    const body = await summary();

    expect(body.payments.total).toBe(db.paymentCount);
    expect(body.payments.grossTotal).toBeCloseTo(db.grossTotal, 2);
    expect(body.payments.netTotal).toBeCloseTo(db.netTotal, 2);
    expect(body.payments.tdsTotal).toBeCloseTo(db.tdsTotal, 2);
  });

  it('counts the outstanding amount net of part payments, and excludes rejected invoices', async () => {
    const body = await summary();

    expect(body.invoices.openCount).toBe(db.openCount);
    expect(body.invoices.openValue).toBeCloseTo(db.openValue, 2);

    // Issue #283, pinned here because the summary applies the grouping: a
    // rejected invoice is not money the buyer owes, and the open value is
    // strictly less than the face value of the same invoices once any of
    // them is part-settled.
    const rejected = await runWithTenant(CLIENT, () => prisma.invoice.aggregate({
      where: { vendorId: VENDOR, status: INVOICE_STATUS.REJECTED },
      _count: { _all: true }, _sum: { totalAmount: true },
    }));
    expect(rejected._count._all).toBeGreaterThan(0);
    expect(body.invoices.rejectedCount).toBe(rejected._count._all);
    expect(body.invoices.openValue).toBeLessThan(body.invoices.openInvoicedValue);
  });

  it('buckets the outstanding value by age, totalling the open value exactly', async () => {
    const body = await summary();
    const buckets = Object.values(body.invoices.ageing).reduce((sum, n) => sum + n, 0);

    expect(buckets).toBeCloseTo(body.invoices.openValue, 2);
  });

  it('answers the monthly invoiced-and-paid series as numbers, not Decimal strings', async () => {
    const body = await summary();

    expect(body.flow).toHaveLength(12);
    for (const row of body.flow) {
      expect(row.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof row.invoiced).toBe('number');
      expect(typeof row.paid).toBe('number');
    }
  });

  it('leaves no Decimal anywhere in the response', async () => {
    const body = await summary();

    // A Decimal column reaches res.json() as a *string* (utils/money.js), so
    // every figure being a number is the assertion — a single missed
    // `toNumber` puts "1180.00" where the client does arithmetic.
    const walk = (value, path) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (typeof value === 'object') {
        return Object.entries(value).forEach(([key, item]) => walk(item, `${path}.${key}`));
      }
      // Only these are legitimately strings. The path is folded into the
      // assertion so a failure names the field, not just "expected a number".
      if (typeof value === 'string') {
        expect(`${path} = ${value}`).toMatch(/scope|timestamp|month|code|description|plant/);
      }
    };
    walk(body, 'summary');
  });

  it('does not leak another supplier\'s documents into a supplier\'s own figures', async () => {
    const other = await registerVendor(app, {
      vendorId: 'vendor_summary_2', gstin: '27AAAAA9281A1Z1',
      email: 'summary2@example.com', pan: 'AAAAA9281B',
    }, { onboarded: true });

    const body = await auth(other.token)(request(app).get('/api/dashboard/summary'));
    expect(body.status).toBe(200);
    expect(body.body.pos.total).toBe(0);
    expect(body.body.invoices.openValue).toBe(0);
    expect(body.body.ledgerBalance).toBe(0);
  });

  it('answers tenant staff with the whole tenant, and flags no one as MSME-overdue', async () => {
    const staff = await createAdminUser({ email: 'summary-staff@example.com' });

    const res = await auth(staff.token)(request(app).get('/api/dashboard/summary'));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('workspace');
    expect(res.body.pos.total).toBe(db.poCount);
    // There is no one supplier to measure the MSMED Act's 45 days against
    // across a whole tenant, so the flag is off rather than applied to
    // everyone on the strength of one registration.
    expect(res.body.invoices.isMsme).toBe(false);
    expect(res.body.invoices.msmeOverdueCount).toBe(0);
  });
});

describe('the supplier report exports cover every row', () => {
  let supplier;

  beforeEach(async () => {
    supplier = await registerVendor(app, { vendorId: VENDOR, gstin: '27AAAAA9280A1Z1' }, { onboarded: true });
    await seed();
  });

  const csv = async (path) => {
    const res = await auth(supplier.token)(request(app).get(`/api/reports/exports/${path}`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+\.csv"/);
    // Header row plus the data rows.
    return res.text.trim().split('\r\n');
  };

  it('invoice-ageing writes one row per invoice, not one per loaded page', async () => {
    const rows = await csv('invoice-ageing');

    expect(rows).toHaveLength(COUNT + 1);
    expect(rows[0]).toContain('Outstanding (INR)');
  });

  it('account-ledger writes every invoice and every settled invoice', async () => {
    // One credit row per PaymentItem, not per Payment (issue #282) — every
    // payment this fixture seeds settles exactly one invoice, so the dedicated
    // two-invoice case below is what actually distinguishes the two.
    const items = await runWithTenant(CLIENT, () => prisma.paymentItem.count({
      where: { payment: { vendorId: VENDOR } },
    }));
    const rows = await csv('account-ledger');

    expect(rows).toHaveLength(COUNT + items + 1);
  });

  // Issue #282: an F110 run clears several invoices under one clearing
  // document. A single lumped credit balanced the ledger but left each of
  // those invoices' debits with no credit of its own to reconcile against.
  it('account-ledger credits each invoice of a multi-invoice remittance separately', async () => {
    await runWithTenant(CLIENT, () => prisma.payment.create({
      data: {
        id: 'PMT-SUM-MULTI', vendorId: VENDOR, paymentDate: daysAgo(5),
        utrCode: 'UTRSUMMULTI', sapPaymentDoc: 'CLRMULTI',
        grossAmount: 900, tdsDeducted: 90, netAmount: 810, totalTds: 90,
        items: {
          create: [
            {
              clientId: CLIENT, invoiceId: 'INV-SUM-0000', poId: 'PO-SUM-0000',
              invoiceNumber: 'S/0', grossAmount: 600, tdsDeducted: 60, netAmount: 540,
            },
            {
              clientId: CLIENT, invoiceId: 'INV-SUM-0002', poId: 'PO-SUM-0002',
              invoiceNumber: 'S/2', grossAmount: 300, tdsDeducted: 30, netAmount: 270,
            },
          ],
        },
      },
    }));

    const rows = await csv('account-ledger');
    const credits = rows.filter((row) => row.includes('UTRSUMMULTI'));

    expect(credits).toHaveLength(2);
    // Each row names its own invoice and carries that invoice's own gross
    // (net + TDS) — 540+60 and 270+30, summing to the remittance's 900.
    expect(credits.find((row) => row.includes('Payment for S/0'))).toContain('600.00');
    expect(credits.find((row) => row.includes('Payment for S/2'))).toContain('300.00');
    // Not one row naming both, which is what this looked like before.
    expect(rows.some((row) => row.includes('Payment for S/0, S/2'))).toBe(false);
  });

  it('spend-by-material writes one row per material across every order', async () => {
    const rows = await csv('spend-by-material');

    expect(rows).toHaveLength(4 + 1);
  });

  it('tds writes one row per settled invoice', async () => {
    const items = await runWithTenant(CLIENT, () => prisma.paymentItem.count({
      where: { payment: { vendorId: VENDOR } },
    }));
    const rows = await csv('tds');

    expect(rows).toHaveLength(items + 1);
  });

  it('does not hand another supplier\'s rows to a supplier who asks', async () => {
    const other = await registerVendor(app, {
      vendorId: 'vendor_summary_3', gstin: '27AAAAA9282A1Z1',
      email: 'summary3@example.com', pan: 'AAAAA9282B',
    }, { onboarded: true });

    const res = await auth(other.token)(request(app).get('/api/reports/exports/invoice-ageing'));
    expect(res.status).toBe(200);
    // The header row and nothing else.
    expect(res.text.trim().split('\r\n')).toHaveLength(1);
  });

  it('neutralises a formula in a supplier-controlled cell', async () => {
    // materialCode and description reach the file from SAP and from the
    // order; a cell starting with '=' is executed by Excel on open (#75).
    await runWithTenant(CLIENT, () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-SUM-FORMULA', vendorId: VENDOR, status: 'Open', createdDate: new Date(),
        items: {
          create: [{
            clientId: CLIENT, line: 10,
            materialCode: '=HYPERLINK("http://evil","click")', description: '+cmd|calc',
            quantity: 1, unitPrice: 1, netValue: 1,
          }],
        },
      },
    }));

    const rows = await csv('spend-by-material');
    const injected = rows.find((row) => row.includes('HYPERLINK'));

    expect(injected).toMatch(/'=HYPERLINK/);
    expect(injected).toMatch(/'\+cmd\|calc/);
  });
});
