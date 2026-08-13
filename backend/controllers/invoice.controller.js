const Invoice = require('../models/Invoice');
const GRN = require('../models/GRN');
const PurchaseOrder = require('../models/PurchaseOrder');
const Payment = require('../models/Payment');
const Vendor = require('../models/Vendor');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');

const { requireVendorScope, withVendorScope } = require('../utils/requestScope');

// @desc    Get Invoices
// @route   GET /api/invoices
// @access  Public
const getInvoices = asyncHandler(async (req, res, next) => {
  const { status, page = 1, limit = 10 } = req.query;

  const query = withVendorScope(req);
  if (status) {
    query.status = status;
  }

  const skip = (page - 1) * limit;
  const invoices = await Invoice.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await Invoice.countDocuments(query);

  res.json({
    invoices,
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
  const invoice = await Invoice.findOne({ id: req.params.id });
  if (!invoice) {
    return next(ApiError.notFound('Invoice not found'));
  }
  res.json(invoice);
});

// @desc    Submit Invoice (3-Way Match & Auto-Payment Simulation)
// @route   POST /api/invoices
// @access  Public
const submitInvoice = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { grnId, invoiceNumber, invoiceDate, subTotal, taxAmount, totalAmount, items } = req.body;

  if (!grnId || !invoiceNumber || !invoiceDate || !items || !items.length) {
    return next(ApiError.badRequest('GRN ID, invoiceNumber, invoiceDate, and items are required'));
  }

  const grn = await GRN.findOne({ id: grnId });
  if (!grn) {
    return next(ApiError.notFound('Referenced GRN not found'));
  }

  if (grn.invoiceSubmitted) {
    return next(ApiError.badRequest('An invoice has already been submitted for this GRN'));
  }

  const po = await PurchaseOrder.findOne({ id: grn.poId });
  if (!po) {
    return next(ApiError.notFound('Purchase Order associated with GRN not found'));
  }

  // 3-Way Match Check
  let matchWarning = '';
  const validatedItems = items.map(invItem => {
    const grnItem = grn.items.find(gItem => gItem.line === invItem.line);
    const poItem = po.items.find(pItem => pItem.line === invItem.line);

    if (!grnItem) {
      matchWarning += `Line ${invItem.line}: Item not found in Goods Receipt. `;
    } else {
      const acceptedQty = grnItem.acceptedQuantity;
      const invQty = Number(invItem.quantity);
      
      // Check quantity variance
      if (acceptedQty > 0) {
        const qtyVariance = Math.abs(acceptedQty - invQty) / acceptedQty;
        if (qtyVariance > 0.02) {
          matchWarning += `Line ${invItem.line}: Quantity variance detected (${invQty} billed vs ${acceptedQty} accepted). `;
        }
      }
    }

    if (poItem) {
      const poPrice = poItem.unitPrice;
      const invPrice = Number(invItem.unitPrice);
      if (Math.abs(poPrice - invPrice) > 0.01) {
        matchWarning += `Line ${invItem.line}: Price variance detected (billed ${invPrice} vs PO ${poPrice}). `;
      }
    }

    return {
      line: invItem.line,
      materialCode: invItem.materialCode,
      description: invItem.description || (poItem ? poItem.description : ''),
      quantity: Number(invItem.quantity),
      unitPrice: Number(invItem.unitPrice),
      amount: Number(invItem.amount || (invItem.quantity * invItem.unitPrice))
    };
  });

  const invoiceId = 'INV-' + Math.floor(100000 + Math.random() * 900000);
  const status = matchWarning ? 'Match Warning' : 'Submitted';

  const io = req.app.get('io');
  const { clientId } = req;
  const sap = await getSapAdapterForClient(clientId);

  const invoiceDraft = {
    id: invoiceId,
    invoiceDate: new Date(invoiceDate),
    currency: po.currency || 'INR',
    totalAmount: Number(totalAmount),
    items: validatedItems
  };

  // SAP posts the document and hands back its MIRO number; we store what it
  // gave us rather than inventing a number and hoping they agree.
  const posted = await sap.invoiceCreate({ invoice: invoiceDraft, vendorId });

  const invoice = await Invoice.create({
    id: invoiceId,
    grnId,
    poId: po.id,
    vendorId,
    invoiceNumber,
    invoiceDate: invoiceDraft.invoiceDate,
    sapMiroDoc: posted.sapMiroDoc,
    status,
    subTotal: Number(subTotal || (totalAmount - (taxAmount || 0))),
    taxAmount: Number(taxAmount || 0),
    totalAmount: Number(totalAmount),
    taxCode: po.items[0]?.taxCode || 'G1',
    currency: invoiceDraft.currency,
    matchWarning: matchWarning || undefined,
    items: validatedItems
  });

  // Mark GRN invoiceSubmitted = true
  grn.invoiceSubmitted = true;
  await grn.save();

  // Update PO status to Invoiced
  po.status = 'Invoiced';
  await po.save();

  emitToVendor(io, clientId, vendorId, EVENTS.LOG_NEW, { type: posted.transaction.type, name: posted.transaction.code });

  const vendor = await Vendor.findOne({ vendorId });
  const onCall = ({ code, type }) => emitToVendor(io, clientId, vendorId, EVENTS.LOG_NEW, { type, name: code });

  // The payment run lands when SAP runs F110 — twelve seconds on the
  // simulator. This handler is what we do with the remittance.
  sap.awaitPaymentRun({ invoice, vendor, vendorId, onCall }, async (remittance) => {
    const latestInvoice = await Invoice.findOne({ id: invoice.id });
    const latestPo = await PurchaseOrder.findOne({ id: po.id });

    // An invoice already cleared must not be paid twice.
    if (!latestInvoice || !latestPo || latestInvoice.status === 'Cleared') return null;

    const payment = await Payment.create({
      id: remittance.paymentId,
      invoiceId: latestInvoice.id,
      poId: latestPo.id,
      vendorId: latestInvoice.vendorId,
      invoiceRef: latestInvoice.id,
      invoiceNumber: latestInvoice.invoiceNumber,
      sapMiroDoc: latestInvoice.sapMiroDoc,
      grossAmount: remittance.grossAmount,
      tdsDeducted: remittance.tdsDeducted,
      netAmount: remittance.netAmount,
      paymentDate: remittance.paymentDate,
      utrCode: remittance.utrCode,
      paymentMethod: remittance.paymentMethod,
      sapPaymentDoc: remittance.sapPaymentDoc,
      bankName: remittance.bankName,
      runId: remittance.runId,
      fiscalYear: new Date().getFullYear(),
      quarter: 'Q' + (Math.floor(new Date().getMonth() / 3) + 1),
      tdsSection: remittance.tdsSection,
      deducteePan: remittance.deducteePan,
      deductorTan: remittance.deductorTan,
      totalTds: remittance.tdsDeducted
    });

    latestInvoice.status = 'Cleared';
    latestInvoice.clearedAt = new Date();
    await latestInvoice.save();

    latestPo.status = 'Paid';
    await latestPo.save();

    emitToVendor(io, clientId, latestInvoice.vendorId, EVENTS.PAYMENT_CLEARED, payment);

    return payment;
  });

  res.status(201).json({ message: 'Invoice submitted successfully. Payment will follow from the next SAP payment run.', invoice });
});

// @desc    Update Invoice status
// @route   PUT /api/invoices/:id/status
// @access  Public
const updateInvoiceStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  if (!status) {
    return next(ApiError.badRequest('Status is required'));
  }

  const invoice = await Invoice.findOne({ id: req.params.id });
  if (!invoice) {
    return next(ApiError.notFound('Invoice not found'));
  }

  invoice.status = status;
  await invoice.save();

  res.json({ message: 'Invoice status updated successfully', invoice });
});

// @desc    Post MIRO document in SAP
// @route   POST /api/invoices/:id/miro
// @access  Public
const postMiro = asyncHandler(async (req, res, next) => {
  const invoice = await Invoice.findOne({ id: req.params.id });
  if (!invoice) {
    return next(ApiError.notFound('Invoice not found'));
  }

  // Posting to SAP is what produces a MIRO number, so the call happens even
  // when we already have one — re-posting an already-numbered invoice returns
  // the number it has rather than minting a second.
  const sap = await getSapAdapterForClient(req.clientId);
  const posted = await sap.invoiceCreate({ invoice, vendorId: invoice.vendorId });

  invoice.sapMiroDoc = posted.sapMiroDoc;
  invoice.status = 'Verified';
  await invoice.save();

  res.json({ message: 'MIRO document created successfully in SAP', invoice });
});

module.exports = {
  getInvoices,
  getInvoiceById,
  submitInvoice,
  updateInvoiceStatus,
  postMiro
};
