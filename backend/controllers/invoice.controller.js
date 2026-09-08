const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');

const { requireVendorScope, withVendorScope } = require('../utils/requestScope');
const { matchInvoiceDocument } = require('../sap/mappings/invoice-match');
const { isLineDue } = require('../services/invoicePlan.service');
const { PO_INCLUDE, formatPo } = require('../db/poHelpers');
const { INVOICE_INCLUDE, formatInvoice } = require('../db/invoiceHelpers');
const { createWithUniqueId } = require('../utils/createWithUniqueId');
const { formatPayment } = require('../db/paymentHelpers');
const { enqueue } = require('../jobs/queue');
const { markPending } = require('../jobs/syncState');

// A random 6-digit suffix on a per-tenant-unique id — see createWithUniqueId's
// header for why this needs a retry rather than a plain `create`.
const genInvoiceId = () => 'INV-' + Math.floor(100000 + Math.random() * 900000);

// Shared by submitInvoice and submitPlanInvoice — the wait for AP to post the
// invoice in SAP and F110 to clear it is the same durable job either way,
// keyed on the SAP purchase order number since the portal issued no number of
// its own. jobs/handlers/awaitPaymentRun.js does the actual work (this used
// to run inline here as `schedulePaymentRun`, calling `sap.awaitPaymentRun`
// directly with an in-request closure — see docs/04-sap-runtime-engineering-plan.md
// Phase 1.6 for why that moved to the job runtime).
const scheduleAwaitPaymentRun = async ({ invoice, po, vendorId, clientId }) => {
  await enqueue({
    clientId,
    kind: 'awaitPaymentRun',
    dedupeKey: `awaitPaymentRun:${clientId}:${invoice.id}`,
    args: { invoiceId: invoice.id, poId: po.id, vendorId },
  });
  // Dual identity / sync state (Phase 3).
  await markPending('awaitPaymentRun', { invoiceId: invoice.id });
};

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

// @desc    Submit Invoice (3-Way Match & Auto-Payment Simulation)
// @route   POST /api/invoices
// @access  Public
const submitInvoice = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { grnId, invoiceNumber, invoiceDate, subTotal, taxAmount, totalAmount, items } = req.body;

  if (!grnId || !invoiceNumber || !invoiceDate || !items || !items.length) {
    return next(ApiError.badRequest('Delivery receipt ID, invoiceNumber, invoiceDate, and items are required'));
  }

  const grn = await prisma.gRN.findFirst({ where: { id: grnId }, include: { items: true } });
  if (!grn) {
    return next(ApiError.notFound('The delivery receipt this invoice refers to was not found'));
  }

  if (grn.invoiceSubmitted) {
    return next(ApiError.badRequest('An invoice has already been submitted for this delivery receipt'));
  }

  const po = await prisma.purchaseOrder.findFirst({ where: { id: grn.poId }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('The purchase order for this delivery receipt was not found'));
  }
  const formattedPo = formatPo(po);

  // 3-Way Match Check
  let matchWarning = '';
  const validatedItems = items.map(invItem => {
    const grnItem = grn.items.find(gItem => gItem.line === invItem.line);
    const poItem = formattedPo.items.find(pItem => pItem.line === invItem.line);

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

  const status = matchWarning ? 'Match Warning' : 'Submitted';

  const { clientId } = req;

  // Nothing is posted to SAP here. MIRO is invoice verification — AP's
  // transaction against their own books — so the portal records the supplier's
  // invoice and waits to recognise it in SAP's ledger (awaitPaymentRun below).
  // sapMiroDoc stays null until SAP genuinely has the document.

  // Invoice.id is the only unique constraint this create can hit — see
  // createWithUniqueId's header — so retrying it blindly on a fresh id is safe.
  const invoice = await createWithUniqueId({
    genId: genInvoiceId,
    create: (invoiceId) => prisma.invoice.create({
      data: {
        id: invoiceId,
        grnId,
        poId: po.id,
        vendorId,
        invoiceNumber,
        invoiceDate: new Date(invoiceDate),
        sapMiroDoc: null,
        status,
        subTotal: Number(subTotal || (totalAmount - (taxAmount || 0))),
        taxAmount: Number(taxAmount || 0),
        totalAmount: Number(totalAmount),
        // formattedPo.items[0].taxCode is never actually populated — PurchaseOrderItem
        // carries no taxCode field, in the schema this replaced either — so this
        // has always evaluated to the fallback. Preserved as-is (dead branch, not
        // this migration's to fix).
        taxCode: formattedPo.items[0]?.taxCode || 'G1',
        currency: po.currency || 'INR',
        matchWarning: matchWarning || null,
        items: { create: validatedItems.map((item) => ({ clientId, ...item })) },
      },
      include: INVOICE_INCLUDE,
    }),
  });

  // Mark GRN invoiceSubmitted = true
  await prisma.gRN.update({ where: { pk: grn.pk }, data: { invoiceSubmitted: true } });

  // Update PO status to Invoiced
  await prisma.purchaseOrder.update({ where: { pk: po.pk }, data: { status: 'Invoiced' } });

  // Two waits in one, on a real system: first for AP to post the invoice in
  // SAP, then for F110 to clear it. jobs/handlers/awaitPaymentRun.js does the
  // work; the driver needs the SAP purchase order number to recognise the
  // document, since the portal issued no number of its own.
  await scheduleAwaitPaymentRun({ invoice, po, vendorId, clientId });

  res.status(201).json({ message: 'Invoice submitted successfully. Payment will follow in your buyer’s next payment run.', invoice: formatInvoice(invoice) });
});

// @desc    Submit an invoice against one open entry of a PO line's invoicing
//          plan (periodic or partial) — no goods receipt to match against,
//          since a plan entry is billed on its own schedule.
// @route   POST /api/invoices/plan
// @access  Public
const submitPlanInvoice = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { poId, line, planLineNumber, invoiceNumber, invoiceDate, taxAmount: statedTax } = req.body;

  const po = await prisma.purchaseOrder.findFirst({ where: { id: poId, vendorId }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }
  const formattedPo = formatPo(po);

  const item = formattedPo.items.find((i) => i.line === Number(line));
  if (!item || !item.invoicePlan?.enabled) {
    return next(ApiError.badRequest(`Line ${line} has no invoicing plan configured`));
  }

  const planLine = item.invoicePlan.lines.find((l) => l.lineNumber === Number(planLineNumber));
  if (!planLine) {
    return next(ApiError.notFound('Invoicing plan entry not found'));
  }
  if (planLine.blocked) {
    return next(ApiError.badRequest('This entry is billing-blocked by your buyer'));
  }
  if (planLine.status !== 'Open') {
    return next(ApiError.badRequest(`This entry is already ${planLine.status.toLowerCase()}`));
  }
  // The settlement date is the date the entry becomes billable, not a due date
  // to bill towards. Without this check a supplier on a twelve-month periodic
  // plan could raise all twelve invoices on day one.
  if (!isLineDue(planLine)) {
    return next(ApiError.badRequest(`This entry cannot be invoiced until its settlement date, ${new Date(planLine.settlementDate).toISOString().slice(0, 10)}`));
  }

  // The plan sets the amount — a plan entry is billed for what the buyer
  // scheduled, never for what the supplier types. Only the tax on it is the
  // supplier's to state, and it defaults to 18% GST as elsewhere in the portal.
  const subTotal = planLine.amount;
  const taxAmount = statedTax !== undefined ? Number(statedTax) : Number((subTotal * 0.18).toFixed(2));
  const totalAmount = Number((subTotal + taxAmount).toFixed(2));

  const { clientId } = req;

  // See the earlier submitInvoice for why this is a retry rather than a plain
  // create: Invoice.id is the only unique constraint here, so retrying it
  // blindly on a fresh id is safe.
  const invoice = await createWithUniqueId({
    genId: genInvoiceId,
    create: (invoiceId) => prisma.invoice.create({
      data: {
        id: invoiceId,
        grnId: null,
        poId: po.id,
        vendorId,
        invoiceNumber,
        invoiceDate: new Date(invoiceDate),
        sapMiroDoc: null,
        status: 'Submitted',
        subTotal,
        taxAmount,
        totalAmount,
        taxCode: item.taxCode || 'G1',
        currency: item.invoicePlan.currency || po.currency || 'INR',
        invoicePlanRef: {
          line: item.line,
          planLineNumber: planLine.lineNumber,
          planType: item.invoicePlan.type,
          settlementDate: planLine.settlementDate,
        },
        items: {
          create: [{
            clientId,
            line: item.line,
            materialCode: item.materialCode,
            description: planLine.description || item.description,
            quantity: 1,
            unitPrice: subTotal,
            amount: subTotal
          }],
        },
      },
      include: INVOICE_INCLUDE,
    }),
  });

  const rawItem = po.items.find((i) => i.line === Number(line));
  await prisma.invoicePlanLine.update({
    where: { pk: rawItem.invoicePlan.lines.find((l) => l.lineNumber === Number(planLineNumber)).pk },
    data: { status: 'Invoiced', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, invoicedAt: new Date() },
  });

  await scheduleAwaitPaymentRun({ invoice, po, vendorId, clientId });

  res.status(201).json({ message: 'Invoice submitted against the invoicing plan. Payment will follow in your buyer’s next payment run.', invoice: formatInvoice(invoice) });
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
  submitInvoice,
  submitPlanInvoice,
  updateInvoiceStatus,
  getSapInvoiceStatus
};
