const Invoice = require('../models/Invoice');
const GRN = require('../models/GRN');
const PurchaseOrder = require('../models/PurchaseOrder');
const Payment = require('../models/Payment');
const Vendor = require('../models/Vendor');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { createSapLog } = require('../utils/sapLogger');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');
const { runWithTenant } = require('../utils/tenantContext');

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
  const sapMiroDoc = 'MIRO-51' + Math.floor(100000000 + Math.random() * 900000000);
  const status = matchWarning ? 'Match Warning' : 'Submitted';

  const invoice = await Invoice.create({
    id: invoiceId,
    grnId,
    poId: po.id,
    vendorId,
    invoiceNumber,
    invoiceDate: new Date(invoiceDate),
    sapMiroDoc,
    status,
    subTotal: Number(subTotal || (totalAmount - (taxAmount || 0))),
    taxAmount: Number(taxAmount || 0),
    totalAmount: Number(totalAmount),
    taxCode: po.items[0]?.taxCode || 'G1',
    currency: po.currency || 'INR',
    matchWarning: matchWarning || undefined,
    items: validatedItems
  });

  // Mark GRN invoiceSubmitted = true
  grn.invoiceSubmitted = true;
  await grn.save();

  // Update PO status to Invoiced
  po.status = 'Invoiced';
  await po.save();

  // Log SAP Outbound BAPI
  await createSapLog({
    vendorId,
    type: 'BAPI',
    direction: 'OUTBOUND',
    name: 'BAPI_INCOMINGINVOICE_CREATE',
    payload: {
      HEADER: {
        INVOICE_IND: 'X',
        DOC_TYPE: 'RE',
        DOC_DATE: invoice.invoiceDate,
        PSTNG_DATE: new Date(),
        COMP_CODE: '1000',
        CURRENCY: invoice.currency,
        GROSS_AMOUNT: invoice.totalAmount
      },
      ITEMS: invoice.items
    },
    status: 'SUCCESS',
    documentRef: invoice.id
  });

  const io = req.app.get('io');
  const { clientId } = req;
  emitToVendor(io, clientId, vendorId, EVENTS.LOG_NEW, { type: 'BAPI', name: 'BAPI_INCOMINGINVOICE_CREATE' });

  // Schedule autoPaymentRun after 12 seconds. The timer fires outside the
  // request, so the tenant context has to be re-bound explicitly.
  setTimeout(() => runWithTenant(clientId, async () => {
    try {
      console.log(`[SIMULATOR] Starting payment run for Invoice: ${invoice.id}`);
      
      const latestInvoice = await Invoice.findOne({ id: invoice.id });
      const latestPo = await PurchaseOrder.findOne({ id: po.id });
      const vendor = await Vendor.findOne({ vendorId });

      if (latestInvoice && latestPo && latestInvoice.status !== 'Cleared') {
        const tdsDeducted = Math.round(latestInvoice.totalAmount * 0.01 * 100) / 100;
        const netAmount = latestInvoice.totalAmount - tdsDeducted;
        const pmtId = 'PMT-' + Math.floor(100000 + Math.random() * 900000);
        const sapPaymentDoc = 'PAY-53' + Math.floor(10000000 + Math.random() * 90000000);

        // Create Payment
        const payment = await Payment.create({
          id: pmtId,
          invoiceId: latestInvoice.id,
          poId: latestPo.id,
          vendorId: latestInvoice.vendorId,
          invoiceRef: latestInvoice.id,
          invoiceNumber: latestInvoice.invoiceNumber,
          sapMiroDoc: latestInvoice.sapMiroDoc,
          grossAmount: latestInvoice.totalAmount,
          tdsDeducted,
          netAmount,
          paymentDate: new Date(),
          utrCode: 'UTR' + Date.now() + Math.floor(100 + Math.random() * 900),
          paymentMethod: 'NEFT',
          sapPaymentDoc,
          bankName: 'HDFC Bank Ltd',
          runId: 'F110-' + Date.now().toString().slice(-6),
          fiscalYear: new Date().getFullYear(),
          quarter: 'Q' + (Math.floor(new Date().getMonth() / 3) + 1),
          tdsSection: '194C',
          deducteePan: vendor ? vendor.pan : 'PAN-MOCK123',
          deductorTan: 'TAN-SAP1000',
          totalTds: tdsDeducted
        });

        // Update Invoice status to Cleared
        latestInvoice.status = 'Cleared';
        latestInvoice.clearedAt = new Date();
        await latestInvoice.save();

        // Update PO status to Paid
        latestPo.status = 'Paid';
        await latestPo.save();

        // Log SAP Inbound Payment Sync
        await createSapLog({
          vendorId: latestInvoice.vendorId,
          type: 'OData',
          direction: 'INBOUND',
          name: 'FBL1N_RFITEMGL',
          payload: payment,
          status: 'SUCCESS',
          documentRef: payment.id
        });

        emitToVendor(io, clientId, latestInvoice.vendorId, EVENTS.PAYMENT_CLEARED, payment);
        emitToVendor(io, clientId, latestInvoice.vendorId, EVENTS.LOG_NEW, { type: 'OData', name: 'FBL1N_RFITEMGL' });

        console.log(`[SIMULATOR] Auto-payment run completed: ${payment.id} (UTR: ${payment.utrCode})`);
      }
    } catch (err) {
      console.error('[SIMULATOR] Failed to auto-execute payment run:', err);
    }
  }), 12000);

  res.status(201).json({ message: 'Invoice submitted successfully. Payment scheduled in 12 seconds.', invoice });
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

  if (!invoice.sapMiroDoc) {
    invoice.sapMiroDoc = 'MIRO-51' + Math.floor(100000000 + Math.random() * 900000000);
  }
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
