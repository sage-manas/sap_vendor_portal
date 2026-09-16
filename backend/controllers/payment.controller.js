const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');
const { getTenantId } = require('../utils/tenantContext');
const { withVendorScope, requireVendorScope, scopedWhere } = require('../utils/requestScope');
const { fiscalPeriodOf, fiscalYearLabel, fiscalQuarterLabel } = require('../utils/fiscalPeriod');
const { createWithUniqueId } = require('../utils/createWithUniqueId');
const { formatPayment, flattenPaymentItems } = require('../db/paymentHelpers');

const PAYMENT_INCLUDE = { items: true };

// @desc    Get Payments
// @route   GET /api/payments
// @access  Public
const getPayments = asyncHandler(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;

  const where = withVendorScope(req);

  const skip = (page - 1) * limit;
  const [payments, total] = await Promise.all([
    prisma.payment.findMany({ where, include: PAYMENT_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.payment.count({ where }),
  ]);

  res.json({
    payments: payments.map(formatPayment),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Every payment SAP itself has made to this vendor — the ledger
//          behind the Payment Tracking tab, cross-checked against our own rows
// @route   GET /api/payments/sap-status
// @access  Public
const getSapPaymentStatus = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  // The mock driver has no database of its own, so it is handed the rows we
  // already track and re-describes them; the real driver ignores this and asks
  // SAP. Same call either way, which is the point of the adapter. Flattened
  // to one row per settled item (issue #63) — see flattenPaymentItems.
  const payments = await prisma.payment.findMany({ where: { vendorId }, include: PAYMENT_INCLUDE, orderBy: { createdAt: 'desc' } });

  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.vendorPaymentDisplay({ vendor, payments: flattenPaymentItems(payments) });

  res.json({ payments: result.payments });
});

// @desc    TDS deducted per fiscal quarter, from the payments this portal has
//          actually recorded. Deliberately NOT a Form 16A: that is a statutory
//          certificate the deductor issues from TRACES after filing its
//          quarterly Form 26Q return, and nothing in this portal knows whether
//          that return was filed. This is the deduction ledger behind it —
//          real numbers, honestly labelled — and the certificate itself is
//          requested from Finance through the communications hub.
// @route   GET /api/payments/tds-summary
// @access  payment:read
const getTdsSummary = asyncHandler(async (req, res) => {
  const payments = await prisma.payment.findMany({ where: withVendorScope(req), orderBy: { paymentDate: 'desc' } });

  // Tenant staff (client_admin/buyer/finance) call this with no vendorId and
  // get every vendor's payments — see withVendorScope above. `byVendor=true`
  // is how a tenant-wide finance view asks for that broken out per supplier
  // instead of blended into one tenant-wide figure per quarter; a supplier's
  // own call is unaffected either way, since every row it produces is already
  // theirs alone.
  const byVendor = req.query.byVendor === 'true';

  const quarters = new Map();
  for (const payment of payments) {
    if (!payment.paymentDate) continue;

    // Stored on the row at payment time, but recomputed here so rows written
    // before the fiscal-period fix (and any written by an older client) are
    // grouped by the same rule as new ones.
    const { fiscalYear, quarter } = fiscalPeriodOf(payment.paymentDate);
    const key = byVendor ? `${fiscalYear}-${quarter}-${payment.vendorId}` : `${fiscalYear}-${quarter}`;

    if (!quarters.has(key)) {
      quarters.set(key, {
        id: key,
        fiscalYear,
        fiscalYearLabel: fiscalYearLabel(fiscalYear),
        quarter,
        quarterLabel: fiscalQuarterLabel(quarter),
        ...(byVendor && { vendorId: payment.vendorId }),
        taxWithheld: 0,
        paymentCount: 0,
        grossPaid: 0,
        // Null unless SAP told us. tdsSection needs the withholding-tax
        // reporting API and deductorTan is the buyer's own registration —
        // neither is invented here.
        section: null,
        deductorTan: null,
        deducteePan: null,
        firstPaymentDate: payment.paymentDate,
        lastPaymentDate: payment.paymentDate,
        // Tracked to decide, once every payment is folded in, whether this
        // row may honestly carry a single PAN/section/TAN — not returned.
        _vendorIds: new Set(),
      });
    }

    const row = quarters.get(key);
    row.taxWithheld += Number(payment.tdsDeducted) || 0;
    row.grossPaid += Number(payment.grossAmount) || 0;
    row.paymentCount += 1;
    row._vendorIds.add(payment.vendorId);
    row.section = row.section || payment.tdsSection || null;
    row.deductorTan = row.deductorTan || payment.deductorTan || null;
    row.deducteePan = row.deducteePan || payment.deducteePan || null;
    if (payment.paymentDate < row.firstPaymentDate) row.firstPaymentDate = payment.paymentDate;
    if (payment.paymentDate > row.lastPaymentDate) row.lastPaymentDate = payment.paymentDate;
  }

  const rows = [...quarters.values()]
    .filter((row) => row.taxWithheld > 0)
    .map(({ _vendorIds, ...row }) => (
      // A quarter that blends more than one vendor's payments has no single
      // correct deductee — attributing one vendor's PAN (or the shared
      // deductorTan/section) to a merged total would misrepresent whose
      // compliance record this figure belongs to. The sum itself is still
      // correct and stays; only the per-vendor identifiers are withheld.
      _vendorIds.size > 1
        ? { ...row, section: null, deductorTan: null, deducteePan: null }
        : row
    ))
    .sort((a, b) => (b.fiscalYear - a.fiscalYear) || b.quarter.localeCompare(a.quarter));

  res.json({
    quarters: rows,
    // The screen renders this rather than asserting a filing status it cannot
    // know. Kept server-side so the caveat and the numbers cannot drift apart.
    disclaimer: 'TDS deducted from payments recorded in this portal. Form 16A certificates are issued by Finance after the quarterly return is filed.',
  });
});

// @desc    Get Payment by ID
// @route   GET /api/payments/:id
// @access  Public
const getPaymentById = asyncHandler(async (req, res, next) => {
  const payment = await prisma.payment.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: PAYMENT_INCLUDE });
  if (!payment) {
    return next(ApiError.notFound('Payment not found'));
  }
  res.json(formatPayment(payment));
});

// @desc    Create Payment — a manual/off-cycle remittance a finance user
//          records by hand, distinct from the two SAP-discovered paths
//          (jobs/handlers/awaitPaymentRun.js, sweepPayments.js). Accepts
//          either a real `items` array (settling several invoices at once,
//          the same shape those two paths produce) or the old flat
//          single-invoice fields, folded into one item for convenience —
//          see recordPaymentItem's shape in db/paymentHelpers.js.
// @route   POST /api/payments
// @access  Public
const createPayment = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);

  // A bank-account change awaiting approval (issue #53) means the payout
  // details on file are, by definition, in dispute — releasing money while
  // that's unresolved is exactly the window an account-takeover attack needs.
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (vendor?.pendingBankChange) {
    return next(ApiError.badRequest(
      'This supplier has a bank-account change awaiting approval. Approve or reject it before releasing payment.',
      { reason: 'bank_change_pending' },
    ));
  }

  const {
    id, items: rawItems, poId, invoiceId, invoiceNumber, sapMiroDoc, grossAmount, tdsDeducted, netAmount,
    ...header
  } = req.body;

  const items = Array.isArray(rawItems) && rawItems.length
    ? rawItems
    : (poId && invoiceId) ? [{ poId, invoiceId, invoiceNumber, sapMiroDoc, grossAmount, tdsDeducted, netAmount }] : [];

  if (!items.length) {
    return next(ApiError.badRequest('At least one settled invoice (poId + invoiceId, or an items array) is required'));
  }

  const sum = (key) => items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
  const clientId = getTenantId();

  const create = (paymentId) => prisma.payment.create({
    data: {
      ...header,
      id: paymentId,
      vendorId,
      grossAmount: sum('grossAmount'),
      tdsDeducted: sum('tdsDeducted'),
      netAmount: sum('netAmount'),
      totalTds: sum('tdsDeducted'),
      items: {
        create: items.map((item) => ({
          clientId,
          invoiceId: item.invoiceId,
          poId: item.poId,
          invoiceNumber: item.invoiceNumber,
          sapMiroDoc: item.sapMiroDoc,
          grossAmount: item.grossAmount,
          tdsDeducted: item.tdsDeducted || 0,
          netAmount: item.netAmount,
        })),
      },
    },
    include: PAYMENT_INCLUDE,
  });

  // A caller-supplied id is trusted as-is — colliding with an existing one is
  // the caller's own duplicate to resolve (surfaced as a 409, mapped by
  // utils/prismaErrors.js), not something to paper over by silently swapping
  // in a different id than the one they asked for. Only the generated
  // fallback — a random 6-digit suffix on a per-tenant-unique id — gets the
  // retry; see createWithUniqueId's header for why that one needs it.
  const payment = id
    ? await create(id)
    : await createWithUniqueId({ genId: () => 'PMT-' + Math.floor(100000 + Math.random() * 900000), create });
  res.status(201).json(formatPayment(payment));
});

module.exports = {
  getPayments,
  getSapPaymentStatus,
  getTdsSummary,
  getPaymentById,
  createPayment
};
