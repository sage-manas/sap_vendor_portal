// Every headline figure a supplier's Overview and Reports screens show,
// computed in the database.
//
// Issue #280. Those screens used to derive all of it in the browser from
// `state.pos` / `state.invoices` / `state.payments` — arrays that hold one
// page of the list endpoints. A supplier with eleven invoices saw totals,
// charts and CSV exports computed over ten of them, with nothing on screen
// saying so. "Open orders", "Awaiting payment", order value by month, the
// ageing buckets and the ledger balance were all a page-size artefact.
//
// So the numbers come from here instead, and the client renders them rather
// than recomputing anything. Two rules this file keeps:
//
//   1. Status groupings come from config/statuses.js, never written inline.
//      The Overview and Reports pages genuinely ask two different questions
//      about an "open" order (PO_AWAITING_SUPPLIER vs PO_IN_FLIGHT) — both
//      are answered here, separately and by name, so neither screen has to
//      pick a filter and hope.
//   2. Decimal columns go through utils/money.js's `toNumber`. A Prisma
//      `_sum` of a Decimal column is a Decimal, and `JSON.stringify` makes
//      that a string, not a number.
//
// Where a figure needs line items joined to their parent's date or status,
// Prisma cannot `groupBy` across the relation, so those read a narrow
// projection (the columns summed, nothing else) and reduce in JS. That is
// still the whole set, not a page of it — which is the entire point — and
// it is bounded by one supplier's own document history.

const { prisma } = require('../db/prisma');
const { toNumber } = require('../utils/money');
const { toNumber: toQty } = require('../utils/quantity');
const {
  INVOICE_STATUS,
  INVOICE_OPEN,
  PO_STATUS,
  PO_STATUSES,
  PO_AWAITING_SUPPLIER,
  PO_IN_FLIGHT,
} = require('../config/statuses');

const DAY_MS = 24 * 60 * 60 * 1000;

// India's MSMED Act payment window — the same 45 days the supplier's Reports
// page flags, computed here so the flag survives the page boundary too.
const MSME_PAYMENT_DAYS = 45;

// How much of the invoiced-vs-paid series to serve. The chart offers 6 and 12
// months, so 12 is served once and the client slices; a narrower request
// would only mean a second round trip when the supplier flips the control.
const FLOW_MONTHS = 12;

const monthKeyOf = (date) => {
  const d = new Date(date);
  return Number.isNaN(d.getTime())
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Every month between the first and the last, including the quiet ones: a
// time axis that skips an empty month hides exactly the gap worth seeing.
const monthsBetween = (first, last) => {
  const months = [];
  const cursor = new Date(`${first}-01T00:00:00`);
  while (monthKeyOf(cursor) <= last) {
    months.push(monthKeyOf(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
};

const sumBy = (rows, value) => rows.reduce((total, row) => total + (value(row) || 0), 0);

// --- Purchase orders -------------------------------------------------------

const purchaseOrderSummary = async (where) => {
  const [byStatusRows, items, acknowledged] = await Promise.all([
    prisma.purchaseOrder.groupBy({ by: ['status'], where, _count: { _all: true } }),
    // netValue lives on the line, the date and status on the header, so one
    // narrow projection answers total value, in-flight value, by-month,
    // by-material and by-plant consistently — the same rows behind every one
    // of them, which is why the Reports page's figures could not disagree
    // with each other even if a later read paginated differently.
    prisma.purchaseOrderItem.findMany({
      where: { po: where },
      select: {
        materialCode: true,
        description: true,
        plant: true,
        netValue: true,
        po: { select: { id: true, status: true, createdDate: true } },
      },
    }),
    prisma.purchaseOrder.findMany({
      where: { ...where, acknowledgedAt: { not: null } },
      select: { createdDate: true, acknowledgedAt: true },
    }),
  ]);

  const byStatus = Object.fromEntries(PO_STATUSES.map((status) => [status, 0]));
  for (const row of byStatusRows) byStatus[row.status] = row._count._all;
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);

  const materials = new Map();
  const plants = new Map();
  const months = new Map();
  let totalValue = 0;
  let inFlightValue = 0;

  for (const item of items) {
    const value = toNumber(item.netValue) || 0;
    totalValue += value;
    if (PO_IN_FLIGHT.includes(item.po.status)) inFlightValue += value;

    const code = item.materialCode || '—';
    const material = materials.get(code)
      || { code, description: item.description || '—', poIds: new Set(), value: 0 };
    material.poIds.add(item.po.id);
    material.value += value;
    // The first non-empty description wins, so a line that happens to carry
    // none does not blank out a material's name in the table.
    if (material.description === '—' && item.description) material.description = item.description;
    materials.set(code, material);

    const plant = item.plant || '—';
    plants.set(plant, (plants.get(plant) || 0) + value);

    const month = monthKeyOf(item.po.createdDate);
    if (month) months.set(month, (months.get(month) || 0) + value);
  }

  const monthKeys = [...months.keys()].sort();
  const byMonth = monthKeys.length
    ? monthsBetween(monthKeys[0], monthKeys[monthKeys.length - 1])
      .map((month) => ({ month, value: months.get(month) || 0 }))
    : [];

  const acknowledgementDays = acknowledged
    .filter((po) => po.createdDate)
    .map((po) => (new Date(po.acknowledgedAt) - new Date(po.createdDate)) / DAY_MS);

  return {
    total,
    byStatus,
    awaitingAcknowledgement: byStatus[PO_STATUS.OPEN],
    // Both groupings, named — see the note at the top of this file.
    awaitingSupplierCount: sumBy(PO_AWAITING_SUPPLIER, (status) => byStatus[status]),
    inFlightCount: sumBy(PO_IN_FLIGHT, (status) => byStatus[status]),
    inFlightValue,
    totalValue,
    byMonth,
    byMaterial: [...materials.values()]
      .map(({ poIds, ...row }) => ({ ...row, poCount: poIds.size }))
      .sort((a, b) => b.value - a.value),
    byPlant: [...plants.entries()]
      .map(([plant, value]) => ({ plant, value }))
      .sort((a, b) => b.value - a.value),
    // null, not 0: no acknowledged order means the measure has no value yet,
    // which is a different statement from "acknowledged the same day".
    avgAcknowledgementDays: acknowledgementDays.length
      ? sumBy(acknowledgementDays, (days) => days) / acknowledgementDays.length
      : null,
  };
};

// --- Goods receipts --------------------------------------------------------

const grnSummary = async (where) => {
  const [total, awaitingInvoice, quantities] = await Promise.all([
    prisma.gRN.count({ where }),
    prisma.gRN.count({ where: { ...where, invoiceSubmitted: false } }),
    prisma.grnItem.aggregate({
      where: { grn: where },
      _sum: { receivedQuantity: true, acceptedQuantity: true },
    }),
  ]);

  return {
    total,
    awaitingInvoice,
    receivedQuantity: toQty(quantities._sum.receivedQuantity) || 0,
    acceptedQuantity: toQty(quantities._sum.acceptedQuantity) || 0,
  };
};

// --- Invoices --------------------------------------------------------------

// `outstandingAmount` is not a stored column: an invoice can be settled
// across several F110 runs, so what is still owed is the total less every
// PaymentItem that references it (issue #63, the same arithmetic
// db/invoiceHelpers.js's formatInvoice does per invoice). Summing
// `totalAmount` over "not Cleared" invoices — which is what every screen
// did — therefore overstated a part-paid invoice by whatever had been paid,
// and counted Rejected invoices as owed on top (issue #283).
const outstandingOf = (invoice) => {
  const total = toNumber(invoice.totalAmount) || 0;
  const paid = sumBy(invoice.paymentItems || [], (item) => toNumber(item.grossAmount));
  // Never negative: an overshooting clearing is a reconciliation question
  // for Finance, not a debt the supplier owes back.
  return Math.max(total - paid, 0);
};

// What is still owed over a set of invoices, net of part payments and with
// the decided ones left out. The tenant workspace's own overview headline
// (controllers/workspace.controller.js) needs exactly this figure without any
// of the rest of the summary, and it has to be the same arithmetic — two
// screens quoting "open value" from two definitions is the bug in #283, not
// the fix for it. The clamp is per invoice, which is why this reads the rows
// rather than subtracting two SUMs: one overshooting clearing must not pay
// down another invoice's balance.
const openInvoiceValue = async (where) => {
  const open = await prisma.invoice.findMany({
    where: { ...where, status: { in: INVOICE_OPEN } },
    select: { totalAmount: true, paymentItems: { select: { grossAmount: true } } },
  });
  return { count: open.length, value: sumBy(open, outstandingOf) };
};

const invoiceSummary = async (where, { isMsme, now }) => {
  const [byStatusRows, taxTotals, open] = await Promise.all([
    prisma.invoice.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      _sum: { totalAmount: true },
    }),
    prisma.invoice.aggregate({ where, _sum: { taxAmount: true } }),
    // Only the open ones are read row by row, because only they need an
    // age and a part-payment balance. Terminal invoices are counted and
    // summed in the groupBy above.
    prisma.invoice.findMany({
      where: { ...where, status: { in: INVOICE_OPEN } },
      select: {
        invoiceDate: true,
        totalAmount: true,
        paymentItems: { select: { grossAmount: true } },
      },
    }),
  ]);

  const counts = {};
  const values = {};
  for (const row of byStatusRows) {
    counts[row.status] = row._count._all;
    values[row.status] = toNumber(row._sum.totalAmount) || 0;
  }
  const valueOf = (statuses) => sumBy(statuses, (status) => values[status] || 0);

  const ageing = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  let openValue = 0;
  let msmeOverdueCount = 0;
  let msmeOverdueValue = 0;

  for (const invoice of open) {
    const outstanding = outstandingOf(invoice);
    openValue += outstanding;

    const days = invoice.invoiceDate
      ? Math.max(0, Math.floor((now - new Date(invoice.invoiceDate)) / DAY_MS))
      : 0;
    if (days <= 30) ageing['0-30'] += outstanding;
    else if (days <= 60) ageing['31-60'] += outstanding;
    else if (days <= 90) ageing['61-90'] += outstanding;
    else ageing['90+'] += outstanding;

    if (isMsme && days > MSME_PAYMENT_DAYS) {
      msmeOverdueCount += 1;
      msmeOverdueValue += outstanding;
    }
  }

  return {
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    byStatus: counts,
    openCount: open.length,
    // What is actually still owed, net of part payments.
    openValue,
    clearedCount: counts[INVOICE_STATUS.CLEARED] || 0,
    rejectedCount: counts[INVOICE_STATUS.REJECTED] || 0,
    matchWarningCount: counts[INVOICE_STATUS.MATCH_WARNING] || 0,
    // Face value of every invoice ever raised, and of the open ones — the
    // ledger's debit side, which is gross by definition, unlike openValue.
    invoicedValue: valueOf(Object.keys(values)),
    openInvoicedValue: valueOf(INVOICE_OPEN),
    // A rejected invoice is not a receivable, so it is not a ledger debit
    // either (issue #283).
    receivableValue: valueOf(Object.keys(values).filter((s) => s !== INVOICE_STATUS.REJECTED)),
    taxTotal: toNumber(taxTotals._sum.taxAmount) || 0,
    ageing,
    isMsme,
    msmeOverdueCount,
    msmeOverdueValue,
  };
};

// --- Payments --------------------------------------------------------------

const paymentSummary = async (where) => {
  const totals = await prisma.payment.aggregate({
    where,
    _count: { _all: true },
    _sum: { grossAmount: true, netAmount: true, tdsDeducted: true },
  });

  return {
    total: totals._count._all,
    grossTotal: toNumber(totals._sum.grossAmount) || 0,
    netTotal: toNumber(totals._sum.netAmount) || 0,
    tdsTotal: toNumber(totals._sum.tdsDeducted) || 0,
  };
};

// --- Invoiced vs paid, by month --------------------------------------------

const monthlyFlow = async (where, { now }) => {
  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  start.setMonth(start.getMonth() - (FLOW_MONTHS - 1));

  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...where, invoiceDate: { gte: start } },
      select: { invoiceDate: true, totalAmount: true },
    }),
    prisma.payment.findMany({
      where: { ...where, paymentDate: { gte: start } },
      select: { paymentDate: true, netAmount: true },
    }),
  ]);

  const rows = new Map();
  for (let i = 0; i < FLOW_MONTHS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    rows.set(monthKeyOf(d), { month: monthKeyOf(d), invoiced: 0, paid: 0 });
  }
  const add = (date, field, value) => {
    const row = rows.get(monthKeyOf(date));
    if (row) row[field] += toNumber(value) || 0;
  };
  for (const invoice of invoices) add(invoice.invoiceDate, 'invoiced', invoice.totalAmount);
  for (const payment of payments) add(payment.paymentDate, 'paid', payment.netAmount);

  return [...rows.values()];
};

// --- RFQs ------------------------------------------------------------------

// A supplier's own invitation rate. Scoped by invitation, not by vendorId on
// the RFQ itself — an RFQ has no owning supplier, and a supplier may only
// ever see the ones they were invited to (controllers/rfq.controller.js).
const rfqSummary = async (vendorId) => {
  const invitedWhere = vendorId ? { invitedVendors: { some: { vendorExtId: vendorId } } } : {};
  const quotedWhere = vendorId
    ? { ...invitedWhere, bids: { some: { vendorId } } }
    : { bids: { some: {} } };

  const [invited, quoted, openForBids] = await Promise.all([
    prisma.rFQ.count({ where: invitedWhere }),
    prisma.rFQ.count({ where: quotedWhere }),
    prisma.rFQ.count({
      where: {
        ...invitedWhere,
        status: 'Bidding Open',
        ...(vendorId ? { bids: { none: { vendorId } } } : {}),
      },
    }),
  ]);

  return { invited, quoted, openForBids };
};

/**
 * Every figure the supplier screens render, for one supplier (or, for tenant
 * staff, the whole tenant — `vendorId` null, `where` unscoped).
 *
 * @param {object} args
 * @param {string|null} args.vendorId  the supplier in scope, or null for the tenant
 * @param {object} args.where          the vendor scope as a Prisma filter
 * @param {Date}   [args.now]          "now" for ageing; injected so a test can fix it
 */
const buildSupplierSummary = async ({ vendorId, where, now = new Date() }) => {
  const nowMs = now.getTime();

  // The MSME 45-day clock only applies to a supplier who is registered under
  // the Act. For a tenant-wide read there is no one supplier to ask, so the
  // flag is off and no invoice is reported as MSME-overdue — rather than
  // every one of them being flagged against someone else's registration.
  const vendor = vendorId
    ? await prisma.vendor.findFirst({ where: { vendorId }, select: { msmeNumber: true } })
    : null;
  const isMsme = Boolean(vendor?.msmeNumber);

  const [pos, grns, invoices, payments, flow, rfqs] = await Promise.all([
    purchaseOrderSummary(where),
    grnSummary(where),
    invoiceSummary(where, { isMsme, now: nowMs }),
    paymentSummary(where),
    monthlyFlow(where, { now }),
    rfqSummary(vendorId),
  ]);

  return {
    scope: vendorId ? 'supplier' : 'workspace',
    pos,
    grns,
    invoices,
    payments,
    flow,
    rfqs,
    // What the account ledger's running balance ends on: invoices raise it,
    // payments (net plus the TDS withheld, which settles the debt as much as
    // the cash does) bring it down. Rejected invoices are excluded, matching
    // `receivableValue`.
    ledgerBalance: invoices.receivableValue - (payments.netTotal + payments.tdsTotal),
    // Kept from the first version of this endpoint: four clients in the wild
    // read these names, and nothing is gained by renaming them.
    openPOCount: pos.awaitingSupplierCount,
    pendingGRNsCount: grns.awaitingInvoice,
    invoiceCount: invoices.total,
    totalPaymentsAmount: payments.netTotal || payments.grossTotal,
    timestamp: now.toISOString(),
  };
};

module.exports = {
  buildSupplierSummary,
  MSME_PAYMENT_DAYS,
  FLOW_MONTHS,
  // Exported for the ageing/outstanding tests and for reuse by the report
  // exports, which must bucket a row exactly as the summary did.
  outstandingOf,
  openInvoiceValue,
  monthKeyOf,
};
