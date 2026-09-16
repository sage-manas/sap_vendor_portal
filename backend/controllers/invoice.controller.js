const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');

const { requireVendorScope, withVendorScope, scopedWhere } = require('../utils/requestScope');
const { matchInvoiceDocument, AmbiguousInvoiceMatchError } = require('../sap/mappings/invoice-match');
const { INVOICE_INCLUDE, formatInvoice } = require('../db/invoiceHelpers');
const { flattenPaymentItems } = require('../db/paymentHelpers');
const { mapWithConcurrency } = require('../utils/concurrencyPool');

// At most this many invoicePaymentDetail calls run at once (issue #71) — an
// unbounded Promise.all turned "one call per matched invoice" into a burst of
// as many simultaneous requests as a supplier had matched invoices against
// the customer's own SAP gateway, and the circuit breaker counts every
// failure in that burst toward tripping SAP access off for the whole tenant.
const SAP_DETAIL_CONCURRENCY = 5;

// Adds the PaymentItems formatInvoice needs to compute amountPaid/
// outstandingAmount (issue #63) — only for the reads a supplier/buyer
// actually looks at an invoice's settlement status through; the shared
// INVOICE_INCLUDE stays lean for jobs/handlers/awaitPaymentRun.js's own
// per-tick fetch, which has no use for it.
const INVOICE_INCLUDE_WITH_PAYMENTS = { ...INVOICE_INCLUDE, paymentItems: true };

// @desc    Get Invoices
// @route   GET /api/invoices
// @access  Public
const getInvoices = asyncHandler(async (req, res, next) => {
  const { status, page = 1, limit = 10 } = req.query;

  const where = withVendorScope(req);
  if (status) {
    where.status = status;
  }

  const skip = (page - 1) * limit;
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({ where, include: INVOICE_INCLUDE_WITH_PAYMENTS, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.invoice.count({ where }),
  ]);

  res.json({
    invoices: invoices.map(formatInvoice),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Get Invoice by ID
// @route   GET /api/invoices/:id
// @access  Public
const getInvoiceById = asyncHandler(async (req, res, next) => {
  const invoice = await prisma.invoice.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: INVOICE_INCLUDE_WITH_PAYMENTS });
  if (!invoice) {
    return next(ApiError.notFound('Invoice not found'));
  }
  res.json(formatInvoice(invoice));
});

// @desc    Update Invoice status
// @route   PUT /api/invoices/:id/status
// @access  Public
const updateInvoiceStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  if (!status) {
    return next(ApiError.badRequest('Status is required'));
  }

  const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id } });
  if (!invoice) {
    return next(ApiError.notFound('Invoice not found'));
  }

  const updated = await prisma.invoice.update({ where: { pk: invoice.pk }, data: { status }, include: INVOICE_INCLUDE });
  res.json({ message: 'Invoice status updated successfully', invoice: formatInvoice(updated) });
});

// @desc    Cross-check our invoice records against what SAP itself has
//          posted (MIRO) for this vendor
// @route   GET /api/invoices/sap-status
// @access  Public
const getSapInvoiceStatus = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  // Paginated, not opt-in (unlike GET /pos/sap-status, whose single
  // vendorPoGrnDisplay call costs the same regardless of order count): here
  // the expensive part scales with *how many invoices are being cross-
  // checked*, one invoicePaymentDetail call per matched invoice, so an
  // unbounded default would keep reproducing #71 for the one caller that
  // exists today (useInvoices.js, which asks for neither page nor limit).
  // Defaults match GET /api/invoices' own (page 1, limit 10), so a page load
  // that already only shows a vendor's first 10 invoices doesn't also
  // silently cross-check all the others in the background.
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const skip = (page - 1) * limit;

  const where = { vendorId };
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({ where, include: INVOICE_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.invoice.count({ where }),
  ]);

  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.vendorMiroDisplay({ vendor, invoices: invoices.map(formatInvoice) });
  const documents = result.documents;

  // Which of our invoices does SAP actually hold? The portal posts nothing, so
  // there is no number of ours to look up: an invoice is recognised by matching
  // SAP's ledger on purchase order and gross amount
  // (sap/mappings/invoice-match.js), and the number SAP issued is written back
  // the first time it is recognised — after which the stored number is trusted
  // and no re-matching happens.
  const poNumbers = new Map(
    (await prisma.purchaseOrder.findMany({ where: { id: { in: [...new Set(invoices.map((inv) => inv.poId))] } } }))
      .map((po) => [po.id, po.sapPoNumber]),
  );
  const documentsByMiroDoc = new Map(documents.map((doc) => [doc.miroDoc, doc]));

  const matchedInvoices = [];
  for (const inv of invoices) {
    if (inv.sapMiroDoc && documentsByMiroDoc.has(inv.sapMiroDoc)) {
      matchedInvoices.push(inv);
      continue;
    }
    if (inv.sapMiroDoc) continue;

    let document;
    try {
      document = matchInvoiceDocument(
        { sapPoNumber: poNumbers.get(inv.poId), totalAmount: inv.totalAmount, invoiceDate: inv.invoiceDate },
        documents,
      );
    } catch (error) {
      // Issue #64: a periodic invoicing plan's same-amount siblings that the
      // date tiebreak couldn't separate either. This is a read-only
      // cross-check, not the job that owns this invoice's sync state
      // (jobs/handlers/awaitPaymentRun.js's own watch parks it for manual
      // resolution) — here, the honest answer is the same as "not
      // recognised yet": skip it rather than guessing.
      if (error instanceof AmbiguousInvoiceMatchError) continue;
      throw error;
    }
    if (!document) continue;

    const updated = await prisma.invoice.update({ where: { pk: inv.pk }, data: { sapMiroDoc: document.miroDoc } });
    matchedInvoices.push(updated);
  }

  // Issue #63: Payment is a header over PaymentItem now — an invoice's own
  // settlement is one item, potentially under a clearing document several
  // other invoices share. Reads through PaymentItem and flattens each back
  // into the per-invoice shape invoicePaymentDetail's mock echo expects (see
  // flattenPaymentItems). An invoice settled across two separate runs (the
  // reverse case this redesign exists for) picks the most recent one here —
  // this is a display cross-check, not the source of truth for what's owed.
  const paymentItems = matchedInvoices.length
    ? await prisma.paymentItem.findMany({
      where: { invoiceId: { in: matchedInvoices.map((inv) => inv.id) } },
      include: { payment: true },
      orderBy: { payment: { paymentDate: 'desc' } },
    })
    : [];
  const paymentByInvoiceId = new Map();
  for (const { payment, ...item } of paymentItems) {
    if (!paymentByInvoiceId.has(item.invoiceId)) {
      paymentByInvoiceId.set(item.invoiceId, flattenPaymentItems([{ ...payment, items: [item] }])[0]);
    }
  }

  const paymentDetails = {};
  const needsSapDetail = [];
  for (const inv of matchedInvoices) {
    const localPayment = paymentByInvoiceId.get(inv.id);
    // Issue #71: a cleared invoice's payment detail does not change — it was
    // already captured once, by the job that recorded the clearing
    // (jobs/handlers/awaitPaymentRun.js -> recordPaymentItem), the same way
    // sapMiroDoc itself is only ever re-matched once. Re-reading it from SAP
    // on every page load is exactly the unbounded fan-out this issue is
    // about, and the answer is already sitting in Payment/PaymentItem.
    if (localPayment) {
      paymentDetails[inv.sapMiroDoc] = {
        found: true,
        status: 'CLEARED',
        grossAmount: localPayment.grossAmount,
        tdsDeducted: localPayment.tdsDeducted,
        netDisbursed: localPayment.netAmount,
        clearingDocument: localPayment.sapPaymentDoc || null,
        clearingDate: localPayment.paymentDate,
        postingDate: localPayment.paymentDate,
        paymentMethod: localPayment.paymentMethod || null,
        utrReference: localPayment.utrCode || null,
      };
      continue;
    }
    needsSapDetail.push(inv);
  }

  // Only a matched-but-not-yet-cleared invoice (SAP has posted the MIRO
  // document but AP hasn't run the payment yet) still needs a live read, and
  // even that is bounded rather than one uncapped burst per page load.
  await mapWithConcurrency(needsSapDetail, SAP_DETAIL_CONCURRENCY, async (inv) => {
    const doc = documentsByMiroDoc.get(inv.sapMiroDoc);
    const detail = await sap.invoicePaymentDetail({
      invoiceDocNo: doc.miroDoc,
      fiscalYear: doc.fiscalYear,
      payment: paymentByInvoiceId.get(inv.id),
    });
    if (detail.found) paymentDetails[inv.sapMiroDoc] = detail;
  });

  res.json({
    documents,
    paymentDetails,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
});

module.exports = {
  getInvoices,
  getInvoiceById,
  updateInvoiceStatus,
  getSapInvoiceStatus
};
