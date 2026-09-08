const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');
const { TtlCache } = require('../utils/ttlCache');

const { requireVendorScope, withVendorScope } = require('../utils/requestScope');
const {
  buildPlan,
  summarizePlan,
  billablePlanLines,
  hasInvoicePlan,
  InvoicePlanError,
} = require('../services/invoicePlan.service');
const { PO_INCLUDE, formatPlan, formatPo, persistInvoicePlan, disableInvoicePlan } = require('../db/poHelpers');
const { createWithUniqueId } = require('../utils/createWithUniqueId');
const { toNumber } = require('../utils/money');
const { enqueue } = require('../jobs/queue');
const { markPending } = require('../jobs/syncState');

// A random 6-digit suffix on a per-tenant-unique id — see createWithUniqueId's
// header for why this needs a retry rather than a plain `create`.
const genAsnId = () => 'ASN-' + Math.floor(100000 + Math.random() * 900000);

// zpo_grn_vendor/Detail (see sap/drivers/s4odata.driver.js) has no filter of
// its own — every call returns this vendor's entire PO/GRN history, 22-84s
// observed against the live sandbox for ~170 orders. Caching the normalized
// result means a page reload or a second tab doesn't pay that again.
// Keyed per tenant+vendor since the same vendorId can exist in different
// tenants' SAP connections.
const sapPoGrnCache = new TtlCache({ defaultTtlMs: Number(process.env.SAP_PO_GRN_CACHE_TTL_MS) || 5 * 60 * 1000 });

// @desc    Get POs
// @route   GET /api/pos
// @access  Public
const getPOs = asyncHandler(async (req, res, next) => {
  const { status, page = 1, limit = 10 } = req.query;

  const where = withVendorScope(req);
  if (status) {
    where.status = status;
  }

  const skip = (page - 1) * limit;
  const [pos, total] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, include: PO_INCLUDE, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.purchaseOrder.count({ where }),
  ]);

  res.json({
    pos: pos.map(formatPo),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Every PO SAP itself has for this vendor, with line items and GRNs
//          nested in — a cross-check against our internal PO/GRN tracking.
//          `page`/`limit` slice the cached result by PO date (newest first);
//          without them the full list comes back, same as before pagination
//          existed — the cross-check badge in PurchaseOrdersView needs every
//          order to know what's missing, not just one page of it.
// @route   GET /api/pos/sap-status
// @access  Public
const getSapPoStatus = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  const { page, limit, refresh } = req.query;
  const cacheKey = `${req.clientId}:${vendorId}`;

  let orders = refresh === 'true' ? undefined : sapPoGrnCache.get(cacheKey);
  if (!orders) {
    const pos = await prisma.purchaseOrder.findMany({ where: { vendorId }, include: PO_INCLUDE });
    const sap = await getSapAdapterForClient(req.clientId);
    const result = await sap.vendorPoGrnDisplay({ vendor, pos: pos.map(formatPo) });
    orders = result.orders;
    sapPoGrnCache.set(cacheKey, orders);

    // A driver that built these rows from our own POs (the mock; see its
    // vendorPoGrnDisplay) can tell us which one each row is, via `poId`. Where
    // it did, and our record doesn't have SAP's number yet, this is the one
    // place that number is learned — nowhere else writes it (award creates the
    // PO with sapPoNumber: null, deliberately; see rfq.controller.js). Once
    // stored, the portal's own "Confirmed by SAP" badge (isConfirmedInSap in
    // PurchaseOrdersView.jsx) has something to compare against instead of
    // permanently reading unconfirmed. The real driver answers `poId: null`
    // for every row (see s4odata.driver.js) since SAP's report carries no
    // reference back to our record, so this is a no-op against a live system
    // until a real correlation key exists.
    const toBackfill = pos.filter((po) => !po.sapPoNumber
      && orders.some((order) => order.poId === po.id && order.poNumber));
    if (toBackfill.length) {
      await Promise.all(toBackfill.map((po) => {
        const match = orders.find((order) => order.poId === po.id);
        return prisma.purchaseOrder.update({
          where: { pk: po.pk },
          data: {
            sapPoNumber: match.poNumber,
            // Dual identity / sync state (Phase 3 of
            // docs/04-sap-runtime-engineering-plan.md): this correlation is
            // exactly what moves a PO from `pending` to `synced` —
            // sapDocNumber mirrors sapPoNumber so the reconciliation queue
            // can read all six document types uniformly.
            sapDocNumber: match.poNumber,
            sapSyncState: 'synced',
            sapSyncedAt: new Date(),
            sapSyncError: null,
          },
        });
      }));
    }
  }

  if (page === undefined && limit === undefined) {
    return res.json({ orders });
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));
  // poDate is YYYY-MM-DD (or null for a row SAP never dated) — string
  // descending sort is correct for that format without parsing it.
  const sorted = [...orders].sort((a, b) => (b.poDate || '').localeCompare(a.poDate || ''));
  const start = (pageNum - 1) * pageSize;

  res.json({
    orders: sorted.slice(start, start + pageSize),
    pagination: {
      total: orders.length,
      page: pageNum,
      limit: pageSize,
      pages: Math.ceil(orders.length / pageSize),
    },
  });
});

// @desc    Get PO by ID
// @route   GET /api/pos/:id
// @access  Public
const getPOById = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }
  res.json(formatPo(po));
});

// @desc    Acknowledge PO
// @route   PUT /api/pos/:id/acknowledge
// @access  Public
const acknowledgePO = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id } });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  if (po.status !== 'Open') {
    return next(ApiError.badRequest(`Purchase Order cannot be acknowledged in '${po.status}' state`));
  }

  const updated = await prisma.purchaseOrder.update({
    where: { pk: po.pk },
    data: { status: 'Acknowledged', acknowledgedAt: new Date() },
    include: PO_INCLUDE,
  });

  const sap = await getSapAdapterForClient(req.clientId);
  const { transaction } = await sap.poAcknowledge({ po: formatPo(updated) });

  const io = req.app.get('io');
  emitToVendor(io, req.clientId, updated.vendorId, EVENTS.LOG_NEW, { type: transaction.type, name: transaction.code });

  res.json({ message: 'Purchase Order acknowledged successfully', po: formatPo(updated) });
});

// @desc    Submit ASN (Advanced Shipping Notification)
// @route   POST /api/pos/:id/asn
// @access  Public
const submitASN = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { carrierName, trackingNumber, vehicleNumber, invoiceReference, ewayBillNo, shipDate, estimatedDeliveryDate, items } = req.body;

  if (!items || !items.length) {
    return next(ApiError.badRequest('Shipment items are required'));
  }

  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  if (po.status !== 'Acknowledged') {
    return next(ApiError.badRequest(`Cannot send shipment details for an order with status '${po.status}'. Acknowledge the order first.`));
  }

  // Validate items remaining quantities
  const validatedItems = items.map(asnItem => {
    const poItem = po.items.find(pItem => pItem.line === asnItem.line);
    if (!poItem) {
      throw ApiError.badRequest(`Item with line number ${asnItem.line} does not exist on this Purchase Order`);
    }

    const shippedQty = Number(asnItem.shippedQuantity);
    if (shippedQty <= 0) {
      throw ApiError.badRequest(`Shipped quantity for line ${asnItem.line} must be greater than 0`);
    }

    const remainingQty = poItem.quantity - poItem.grnQuantity;
    if (shippedQty > remainingQty) {
      throw ApiError.badRequest(`Shipped quantity (${shippedQty}) exceeds remaining unreceived quantity (${remainingQty}) for line ${asnItem.line}`);
    }

    return {
      line: asnItem.line,
      materialCode: poItem.materialCode,
      description: poItem.description,
      shippedQuantity: shippedQty,
      uom: poItem.uom || 'EA'
    };
  });

  const { clientId } = req;

  // ASN.id is the only unique constraint this create can hit — see
  // createWithUniqueId's header — so retrying it blindly on a fresh id is safe.
  const asn = await createWithUniqueId({
    genId: genAsnId,
    create: (asnId) => prisma.aSN.create({
      data: {
        id: asnId,
        poId: po.id,
        vendorId,
        status: 'Submitted',
        shipDate: shipDate ? new Date(shipDate) : new Date(),
        estimatedDeliveryDate: estimatedDeliveryDate ? new Date(estimatedDeliveryDate) : new Date(Date.now() + 86400000 * 2),
        carrierName,
        trackingNumber,
        vehicleNumber,
        invoiceReference,
        ewayBillNo,
        // The portal does not create an inbound delivery in SAP — the dispatch
        // notice is recorded here, and the goods receipt is discovered by polling
        // SAP's own PO/GRN ledger on the purchase order number (awaitGoodsReceipt),
        // which never referenced a delivery document anyway.
        sapInboundDelivery: null,
        items: { create: validatedItems.map((item) => ({ clientId, ...item })) },
      },
      include: { items: true },
    }),
  });

  // Update PO status to Dispatched
  await prisma.purchaseOrder.update({ where: { pk: po.pk }, data: { status: 'Dispatched' } });

  // The goods receipt arrives when SAP says it does. jobs/handlers/awaitGoodsReceipt.js
  // does the actual work (this used to run inline here as a closure passed to
  // `sap.awaitGoodsReceipt` — see docs/04-sap-runtime-engineering-plan.md
  // Phase 1.6 for why that moved to the durable job runtime).
  await enqueue({
    clientId,
    kind: 'awaitGoodsReceipt',
    dedupeKey: `awaitGoodsReceipt:${clientId}:${asn.id}`,
    args: { asnId: asn.id, poId: po.id, vendorId },
  });
  // Dual identity / sync state (Phase 3): the ASN starts life `local` until
  // this watch begins.
  await markPending('awaitGoodsReceipt', { asnId: asn.id });

  res.status(201).json({ message: 'Shipment details submitted successfully. Your buyer will confirm the delivery once the goods arrive.', asn });
});

// @desc    Get ASN for PO
// @route   GET /api/pos/:id/asn
// @access  Public
const getASNForPO = asyncHandler(async (req, res, next) => {
  const asns = await prisma.aSN.findMany({ where: { poId: req.params.id }, include: { items: true } });
  res.json(asns);
});

// @desc    Get all ASNs for current vendor
// @route   GET /api/asns
// @access  Public
const getASNs = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const asns = await prisma.aSN.findMany({ where: { vendorId }, include: { items: true }, orderBy: { createdAt: 'desc' } });
  res.json(asns);
});

// --- Invoicing plans -------------------------------------------------------
//
// A PO line item with an invoicing plan is not invoiced against goods receipts
// at all — that is the whole point of one. A periodic plan bills a recurring
// charge on a schedule and a partial plan bills one item value across milestone
// dates; in neither case is there a GRN to three-way match against, which is why
// these live beside the order rather than beside the delivery.
//
// Every read below is gated on `invoicePlan.enabled`. An order without invoice
// planning switched on answers an empty plan list and behaves exactly as it did
// before this existed.

// unitPrice/netValue and the plan's own amount fields are Decimal-typed
// columns. Most callers already pass an `item` that has been through
// formatPo/formatPlan (which convert them) — but syncInvoicePlan below builds
// `item` from a raw `po.items` read, and passing a raw Decimal plan straight
// into summarizePlan() below hits the string-concatenation trap
// utils/money.js documents (`sum + line.amount` silently concatenates instead
// of adding). formatPlan()/toNumber() are idempotent on already-converted
// input, so guaranteeing the conversion here — rather than trusting every
// caller to have done it first — costs nothing for the callers that already
// have and fixes the one that didn't.
const planItemView = (item, asOf) => {
  const plan = formatPlan(item.invoicePlan);
  return {
    line: item.line,
    materialCode: item.materialCode,
    description: item.description,
    quantity: item.quantity,
    unitPrice: toNumber(item.unitPrice),
    netValue: toNumber(item.netValue),
    uom: item.uom,
    plan,
    summary: summarizePlan(plan, asOf),
  };
};

const findPlanItem = (po, line) => {
  const item = (po.items || []).find((candidate) => Number(candidate.line) === Number(line));
  if (!item) throw ApiError.notFound(`Line ${line} does not exist on this purchase order`);
  return item;
};

// @desc    Every invoicing plan on this purchase order, with what is billable now
// @route   GET /api/pos/:id/invoice-plan
// @access  Private (po:read)
const getInvoicePlan = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }
  const formatted = formatPo(po);

  const asOf = new Date();
  res.json({
    poId: formatted.id,
    sapPoNumber: formatted.sapPoNumber || null,
    currency: formatted.currency || 'INR',
    // The flag the whole feature hangs on, reported explicitly so the UI does
    // not have to infer "this order has no plans" from an empty array.
    invoicePlanningEnabled: hasInvoicePlan(formatted),
    items: formatted.items.filter((item) => item.invoicePlan?.enabled).map((item) => planItemView(item, asOf)),
    billable: billablePlanLines(formatted, asOf),
  });
});

// @desc    Configure (or replace) the invoicing plan on one PO line item
// @route   PUT /api/pos/:id/items/:line/invoice-plan
// @access  Private (po:manage — the buying organisation's own staff, never a supplier)
const configureInvoicePlan = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const item = findPlanItem(po, req.params.line);
  const existingPlan = item.invoicePlan?.enabled ? formatPlan(item.invoicePlan) : null;

  // buildPlan carries forward any date already invoiced, so re-planning the
  // remainder of a schedule cannot erase what has been billed. Its own errors
  // are 400s with a sentence a buyer can act on.
  let plan;
  try {
    plan = buildPlan(req.body, {
      item,
      currency: po.currency || 'INR',
      existingPlan,
    });
  } catch (error) {
    if (error instanceof InvoicePlanError) return next(ApiError.badRequest(error.message));
    throw error;
  }

  // Tell SAP before saving: an order whose plan we recorded but never pushed is
  // the one state nobody can reconcile afterwards. A driver that cannot do it
  // (the ECC skeleton) throws not_implemented and the write is refused rather
  // than silently diverging.
  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.poInvoicePlanUpdate({ po: formatPo(po), item: { ...item, invoicePlan: plan }, plan });
  if (result?.planNumber) plan.planNumber = result.planNumber;

  const savedPlan = await persistInvoicePlan(item, plan);

  const io = req.app.get('io');
  if (result?.transaction) {
    emitToVendor(io, req.clientId, po.vendorId, EVENTS.LOG_NEW, { type: result.transaction.type, name: result.transaction.code });
  }

  res.json({
    message: `${plan.type} invoicing plan saved for line ${item.line} — ${plan.lines.length} invoicing ${plan.lines.length === 1 ? 'date' : 'dates'}`,
    item: planItemView({ ...item, invoicePlan: savedPlan }, new Date()),
  });
});

// @desc    Switch invoice planning off for one PO line item
// @route   DELETE /api/pos/:id/items/:line/invoice-plan
// @access  Private (po:manage)
const removeInvoicePlan = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const item = findPlanItem(po, req.params.line);
  if (!item.invoicePlan?.enabled) {
    return next(ApiError.badRequest(`Line ${item.line} has no invoicing plan to remove`));
  }

  // A plan with money already billed against it is a record, not a draft.
  // Removing it would orphan those invoices, so it is refused outright.
  const invoiced = (item.invoicePlan.lines || []).filter((line) => line.invoiceId);
  if (invoiced.length) {
    return next(ApiError.badRequest(`This invoicing plan cannot be removed — ${invoiced.length} of its ${item.invoicePlan.lines.length} dates ${invoiced.length === 1 ? 'has' : 'have'} already been invoiced`));
  }

  await disableInvoicePlan(item);

  res.json({ message: `Invoice planning switched off for line ${item.line}`, poId: po.id, line: item.line });
});

// @desc    Re-read the invoicing plans SAP holds for this order and adopt them
// @route   POST /api/pos/:id/invoice-plan/sync
// @access  Private (po:manage)
const syncInvoicePlan = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const sap = await getSapAdapterForClient(req.clientId);
  const { plans = [] } = await sap.poInvoicePlanDisplay({ po: formatPo(po) });

  const adopted = [];
  const adoptedItems = [];
  for (const remote of plans) {
    const item = (po.items || []).find((candidate) => Number(candidate.line) === Number(remote.line));
    if (!item) continue;

    const existing = item.invoicePlan?.enabled ? formatPlan(item.invoicePlan) : null;
    const invoicedByNumber = new Map(
      (existing?.lines || []).filter((line) => line.invoiceId).map((line) => [line.lineNumber, line]),
    );

    // The live zinv_milestone/plan read reports none of type, frequency,
    // invoicing rule or periodic amount — every date is just its own
    // percentage/value pair, with nothing to say whether the plan behind it is
    // Periodic or Partial. A plan the portal already knows keeps its own
    // classification (regenerating a periodic plan's *dates* from SAP must not
    // erase that it IS periodic); one discovered fresh, with nothing to carry
    // forward, is recorded as Partial — an honest reading of what this
    // endpoint actually reports, not a guess at what SAP's config says.
    const plan = {
      enabled: true,
      planNumber: remote.planNumber || existing?.planNumber || null,
      type: remote.type || existing?.type || 'Partial',
      startDate: remote.startDate || existing?.startDate,
      endDate: remote.endDate || existing?.endDate,
      frequency: remote.frequency || existing?.frequency || undefined,
      invoicingRule: remote.invoicingRule || existing?.invoicingRule || undefined,
      periodicAmount: remote.periodicAmount ?? existing?.periodicAmount ?? undefined,
      currency: remote.currency || po.currency || 'INR',
      reference: remote.reference || existing?.reference,
      lines: (remote.lines || []).map((line) => {
        const billed = invoicedByNumber.get(line.lineNumber);
        return {
          ...line,
          // SAP knows a date is invoiced; it does not know which of the
          // portal's invoices covered it. Keeping our reference means a sync
          // never breaks the link from a plan date to the invoice on it.
          status: billed ? 'Invoiced' : line.status,
          invoiceId: billed?.invoiceId,
          invoiceNumber: billed?.invoiceNumber,
          invoicedAt: billed?.invoicedAt,
          sapMiroDoc: billed?.sapMiroDoc,
        };
      }),
      source: 'sap',
      syncedAt: new Date(),
    };

    const savedPlan = await persistInvoicePlan(item, plan);
    adoptedItems.push({ ...item, invoicePlan: savedPlan });
    adopted.push(item.line);
  }

  res.json({
    message: adopted.length
      ? `Adopted ${adopted.length} invoicing ${adopted.length === 1 ? 'plan' : 'plans'} from SAP (line ${adopted.join(', ')})`
      : 'SAP holds no invoicing plan for this purchase order',
    adopted,
    items: adoptedItems.map((item) => planItemView(item, new Date())),
  });
});

// @desc    Block or release one invoicing date, without changing the schedule
// @route   PUT /api/pos/:id/items/:line/invoice-plan/lines/:lineNumber/block
// @access  Private (po:manage)
//
// FPLT-FAKSP is a billing block, and it is deliberately separate from the
// date's Open/Invoiced status: a buyer withholding one milestone (a milestone
// disputed, an inspection outstanding) is not cancelling it and is not
// rescheduling the plan. A blocked date stays in the plan, stays owed, and
// simply stops being billable until it is released.
const setInvoicePlanLineBlock = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const item = findPlanItem(po, req.params.line);
  if (!item.invoicePlan?.enabled) {
    return next(ApiError.badRequest(`Line ${item.line} has no invoicing plan`));
  }

  const planLine = (item.invoicePlan.lines || []).find(
    (candidate) => candidate.lineNumber === Number(req.params.lineNumber),
  );
  if (!planLine) {
    return next(ApiError.notFound(`This invoicing plan has no date ${req.params.lineNumber}`));
  }
  if (planLine.status === 'Invoiced') {
    return next(ApiError.badRequest('This invoicing date has already been billed — blocking it now would change nothing'));
  }

  await prisma.invoicePlanLine.update({ where: { pk: planLine.pk }, data: { blocked: req.body.blocked } });
  const updatedPlan = await prisma.invoicePlan.findFirst({ where: { pk: item.invoicePlan.pk }, include: { lines: true } });

  res.json({
    message: `Invoicing date ${planLine.lineNumber} on line ${item.line} ${req.body.blocked ? 'blocked' : 'released'}`,
    item: planItemView({ ...item, invoicePlan: updatedPlan }, new Date()),
  });
});

// @desc    Update PO status
// @route   PUT /api/pos/:id/status
// @access  Public
const updatePOStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  if (!status) {
    return next(ApiError.badRequest('Status is required'));
  }

  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id } });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const updated = await prisma.purchaseOrder.update({ where: { pk: po.pk }, data: { status }, include: PO_INCLUDE });
  res.json({ message: 'PO status updated successfully', po: formatPo(updated) });
});

module.exports = {
  getPOs,
  getPOById,
  acknowledgePO,
  submitASN,
  getASNForPO,
  getASNs,
  updatePOStatus,
  getSapPoStatus,
  getInvoicePlan,
  configureInvoicePlan,
  removeInvoicePlan,
  setInvoicePlanLineBlock,
  syncInvoicePlan
};
