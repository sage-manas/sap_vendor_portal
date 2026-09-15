const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');

const { requireVendorScope, withVendorScope } = require('../utils/requestScope');
const { matchInvoiceDocument } = require('../sap/mappings/invoice-match');
const { INVOICE_INCLUDE, formatInvoice } = require('../db/invoiceHelpers');
const { formatPayment } = require('../db/paymentHelpers');

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
    prisma.invoice.findMany({ where, include: INVOICE_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
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
  const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id }, include: INVOICE_INCLUDE });
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

  const invoices = await prisma.invoice.findMany({ where: { vendorId }, include: INVOICE_INCLUDE, orderBy: { createdAt: 'desc' } });

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

    const document = matchInvoiceDocument(
      { sapPoNumber: poNumbers.get(inv.poId), totalAmount: inv.totalAmount },
      documents,
    );
    if (!document) continue;

    const updated = await prisma.invoice.update({ where: { pk: inv.pk }, data: { sapMiroDoc: document.miroDoc } });
    matchedInvoices.push(updated);
  }

  const payments = matchedInvoices.length
    ? await prisma.payment.findMany({ where: { invoiceId: { in: matchedInvoices.map((inv) => inv.id) } } })
    : [];
  const paymentByInvoiceId = new Map(payments.map((p) => [p.invoiceId, formatPayment(p)]));

  const paymentDetails = {};
  await Promise.all(matchedInvoices.map(async (inv) => {
    const doc = documentsByMiroDoc.get(inv.sapMiroDoc);
    const detail = await sap.invoicePaymentDetail({
      invoiceDocNo: doc.miroDoc,
      fiscalYear: doc.fiscalYear,
      payment: paymentByInvoiceId.get(inv.id),
    });
    if (detail.found) paymentDetails[inv.sapMiroDoc] = detail;
  }));

  res.json({ documents, paymentDetails });
});

module.exports = {
  getInvoices,
  getInvoiceById,
  updateInvoiceStatus,
  getSapInvoiceStatus
};
