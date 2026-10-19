// The supplier's report exports.
//
// Issue #280. These four CSVs were written in the browser from `state.pos` /
// `state.invoices` / `state.payments` — one page of each list endpoint — so
// an export was silently a *page* of the supplier's data, with the file name
// and the column headers of a complete one. Nothing on screen said so, and
// the figure in the KPI card above the table agreed with the file, because
// both were computed from the same ten rows.
//
// They are server reads now: every matching row, no page parameter to get
// wrong, and the same status registry and part-payment arithmetic the
// summary endpoint uses (services/supplierSummary.service.js), so a total in
// a file and the same total on the dashboard cannot disagree.

const asyncHandler = require('../utils/asyncHandler');
const { prisma } = require('../db/prisma');
const { withVendorScope, vendorScope } = require('../utils/requestScope');
const { toCsv, sendCsv } = require('../utils/csv');
const { toNumber } = require('../utils/money');
const { INVOICE_STATUS, INVOICE_OPEN } = require('../config/statuses');
const { outstandingOf, MSME_PAYMENT_DAYS } = require('../services/supplierSummary.service');

const DAY_MS = 24 * 60 * 60 * 1000;

// dd.mm.yyyy — the format these exports have always had. Deliberately not
// toLocaleDateString: the server's locale is not the supplier's, and a
// column that silently changes format with the host is worse than one fixed
// format everyone can read.
const csvDate = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
};

const money2 = (value) => (toNumber(value) || 0).toFixed(2);

const stamp = () => new Date().toISOString().slice(0, 10);

// @desc    Order value by material, every order — not the visible page
// @route   GET /api/reports/exports/spend-by-material
// @access  report:read
const exportSpendByMaterial = asyncHandler(async (req, res) => {
  const items = await prisma.purchaseOrderItem.findMany({
    where: { po: withVendorScope(req) },
    select: {
      materialCode: true,
      description: true,
      netValue: true,
      po: { select: { id: true } },
    },
  });

  const materials = new Map();
  for (const item of items) {
    const code = item.materialCode || '—';
    const row = materials.get(code)
      || { code, description: item.description || '—', poIds: new Set(), value: 0 };
    row.poIds.add(item.po.id);
    row.value += toNumber(item.netValue) || 0;
    if (row.description === '—' && item.description) row.description = item.description;
    materials.set(code, row);
  }

  const rows = [...materials.values()].sort((a, b) => b.value - a.value);

  sendCsv(res, `spend-by-material-${stamp()}.csv`, toCsv([
    { header: 'Material', value: (r) => r.code },
    { header: 'Description', value: (r) => r.description },
    { header: 'Purchase orders', value: (r) => r.poIds.size },
    { header: 'Order value (INR)', value: (r) => money2(r.value) },
  ], rows));
});

// @desc    Invoice ageing, every invoice
// @route   GET /api/reports/exports/invoice-ageing
// @access  report:read
//
// Carries `Outstanding (INR)` beside the invoice total, which the browser
// version could not: what is still owed on a part-settled invoice is the
// total less every PaymentItem against it (issue #63), and the client only
// ever had `totalAmount`.
const exportInvoiceAgeing = asyncHandler(async (req, res) => {
  const vendorId = vendorScope(req);
  const [invoices, vendor] = await Promise.all([
    prisma.invoice.findMany({
      where: withVendorScope(req),
      orderBy: { invoiceDate: 'desc' },
      select: {
        id: true,
        invoiceNumber: true,
        poId: true,
        invoiceDate: true,
        status: true,
        totalAmount: true,
        paymentItems: { select: { grossAmount: true } },
      },
    }),
    vendorId
      ? prisma.vendor.findFirst({ where: { vendorId }, select: { msmeNumber: true } })
      : null,
  ]);

  const isMsme = Boolean(vendor?.msmeNumber);
  const now = Date.now();

  const rows = invoices.map((invoice) => {
    const days = invoice.invoiceDate
      ? Math.max(0, Math.floor((now - new Date(invoice.invoiceDate)) / DAY_MS))
      : 0;
    const open = INVOICE_OPEN.includes(invoice.status);
    return {
      ref: invoice.invoiceNumber || invoice.id,
      poId: invoice.poId,
      date: invoice.invoiceDate,
      status: invoice.status,
      total: toNumber(invoice.totalAmount) || 0,
      // A decided invoice owes nothing, whichever way it was decided —
      // including a rejected one, which the old export counted as owed.
      outstanding: open ? outstandingOf(invoice) : 0,
      days,
      msme: !isMsme
        ? 'Not MSME-registered'
        : (!open ? invoice.status : (days > MSME_PAYMENT_DAYS ? 'Overdue (MSME 45-day)' : 'Within 45 days')),
    };
  });

  sendCsv(res, `invoice-ageing-${stamp()}.csv`, toCsv([
    { header: 'Invoice', value: (r) => r.ref },
    { header: 'Purchase order', value: (r) => r.poId },
    { header: 'Invoice date', value: (r) => csvDate(r.date) },
    { header: 'Status', value: (r) => r.status },
    { header: 'Age (days)', value: (r) => r.days },
    { header: 'Amount (INR)', value: (r) => money2(r.total) },
    { header: 'Outstanding (INR)', value: (r) => money2(r.outstanding) },
    { header: 'MSME 45-day rule', value: (r) => r.msme },
  ], rows));
});

// @desc    The account ledger with its running balance, every row
// @route   GET /api/reports/exports/account-ledger
// @access  report:read
const exportAccountLedger = asyncHandler(async (req, res) => {
  const where = withVendorScope(req);
  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where,
      select: {
        id: true, invoiceNumber: true, poId: true, invoiceDate: true,
        status: true, totalAmount: true,
      },
    }),
    prisma.payment.findMany({
      where,
      select: {
        id: true, utrCode: true, paymentDate: true, createdAt: true,
        netAmount: true, tdsDeducted: true,
        items: { select: { invoiceNumber: true, invoiceId: true } },
      },
    }),
  ]);

  const events = [
    // A rejected invoice is not a receivable (issue #283), so it carries no
    // debit — but it is still shown, as a zero-effect row, rather than
    // disappearing from a ledger the supplier reconciles against their own.
    ...invoices.map((invoice) => ({
      date: invoice.invoiceDate,
      type: 'RE (Invoice)',
      doc: invoice.invoiceNumber || invoice.id,
      desc: `Invoice against ${invoice.poId || 'order'}`,
      debit: invoice.status === INVOICE_STATUS.REJECTED ? 0 : (toNumber(invoice.totalAmount) || 0),
      credit: 0,
      status: invoice.status,
    })),
    // Net plus the TDS withheld: what the buyer withheld settles the debt as
    // much as what they transferred.
    ...payments.map((payment) => ({
      date: payment.paymentDate || payment.createdAt,
      type: 'KZ (Payment)',
      doc: payment.utrCode || payment.id,
      desc: `Payment for ${(payment.items || []).map((i) => i.invoiceNumber || i.invoiceId).filter(Boolean).join(', ') || 'invoice'}`,
      debit: 0,
      credit: (toNumber(payment.netAmount) || 0) + (toNumber(payment.tdsDeducted) || 0),
      status: 'Cleared',
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  let balance = 0;
  const rows = events.map((event) => {
    balance += event.debit - event.credit;
    return { ...event, balance };
  }).reverse();

  sendCsv(res, `account-ledger-${stamp()}.csv`, toCsv([
    { header: 'Date', value: (r) => csvDate(r.date) },
    { header: 'Type', value: (r) => r.type },
    { header: 'Reference', value: (r) => r.doc },
    { header: 'Description', value: (r) => r.desc },
    { header: 'Debit (INR)', value: (r) => money2(r.debit) },
    { header: 'Credit (INR)', value: (r) => money2(r.credit) },
    { header: 'Balance (INR)', value: (r) => money2(r.balance) },
    { header: 'Status', value: (r) => r.status },
  ], rows));
});

// @desc    TDS deducted, every payment
// @route   GET /api/reports/exports/tds
// @access  report:read
//
// One row per settled invoice, not per remittance: an F110 run clears
// several invoices under one clearing document (issue #63), and a supplier
// reconciling TDS against their own 26AS needs the invoice each deduction
// belongs to.
const exportTds = asyncHandler(async (req, res) => {
  const payments = await prisma.payment.findMany({
    where: withVendorScope(req),
    orderBy: { paymentDate: 'desc' },
    select: {
      id: true, utrCode: true, paymentDate: true, tdsSection: true,
      grossAmount: true, tdsDeducted: true, netAmount: true,
      items: {
        select: {
          invoiceId: true, invoiceNumber: true,
          grossAmount: true, tdsDeducted: true, netAmount: true,
        },
      },
    },
  });

  const rows = payments.flatMap((payment) => {
    const header = {
      date: payment.paymentDate,
      utr: payment.utrCode || payment.id,
      section: payment.tdsSection,
    };
    // A remittance with no items recorded is still a real deduction the
    // supplier can see on their statement — written as one row carrying the
    // header's own totals, rather than dropped for having no detail.
    if (!payment.items?.length) {
      return [{
        ...header,
        invoice: '—',
        gross: payment.grossAmount,
        tds: payment.tdsDeducted,
        net: payment.netAmount,
      }];
    }
    return payment.items.map((item) => ({
      ...header,
      invoice: item.invoiceNumber || item.invoiceId,
      gross: item.grossAmount,
      tds: item.tdsDeducted,
      net: item.netAmount,
    }));
  });

  sendCsv(res, `tds-deducted-${stamp()}.csv`, toCsv([
    { header: 'Payment date', value: (r) => csvDate(r.date) },
    { header: 'Invoice', value: (r) => r.invoice },
    { header: 'UTR', value: (r) => r.utr },
    { header: 'TDS section', value: (r) => r.section || '—' },
    { header: 'Gross (INR)', value: (r) => money2(r.gross) },
    { header: 'TDS (INR)', value: (r) => money2(r.tds) },
    { header: 'Net (INR)', value: (r) => money2(r.net) },
  ], rows));
});

module.exports = {
  exportSpendByMaterial,
  exportInvoiceAgeing,
  exportAccountLedger,
  exportTds,
};
