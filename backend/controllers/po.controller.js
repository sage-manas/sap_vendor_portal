const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');
const { EVENTS, emitToVendor, emitToProcurement } = require('../utils/socketEmitter');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { nextSequentialId } = require('../utils/nextSequentialId');
const { lineNetValue } = require('../utils/lineValue');
const { TtlCache } = require('../utils/ttlCache');

const { requireVendorScope, withVendorScope, scopedWhere } = require('../utils/requestScope');
const {
  buildPlan,
  summarizePlan,
  billablePlanLines,
  hasInvoicePlan,
  InvoicePlanError,
  assertDatesOnlyChange,
} = require('../services/invoicePlan.service');
const { PO_INCLUDE, formatPlan, formatPo, persistInvoicePlan, disableInvoicePlan, syncPoStatus } = require('../db/poHelpers');
const { createWithUniqueId } = require('../utils/createWithUniqueId');
const { toNumber } = require('../utils/money');
const { toNumber: toQty } = require('../utils/quantity');
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
  const po = await prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }
  res.json(formatPo(po));
});

// @desc    Acknowledge PO
// @route   PUT /api/pos/:id/acknowledge
// @access  Public
const acknowledgePO = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }) });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  if (po.status !== 'Open') {
    return next(ApiError.badRequest(`Purchase Order cannot be acknowledged in '${po.status}' state`));
  }

  await prisma.purchaseOrder.update({ where: { pk: po.pk }, data: { acknowledgedAt: new Date() } });
  const updated = await syncPoStatus(prisma, po.pk);

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

  const po = await prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: PO_INCLUDE });
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

    const remainingQty = toQty(poItem.quantity) - toQty(poItem.grnQuantity);
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

  // Derive PO status from the shipment that now exists (issue #60), rather
  // than declaring it Dispatched outright.
  await syncPoStatus(prisma, po.pk);

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
  // Scoped on the parent PO, not the ASN rows themselves — an ASN carries its
  // own vendorId (always the PO's), but the check that matters is whether the
  // caller may see this PO at all.
  const po = await prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }) });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

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

// --- Asset purchase orders (the one document the portal creates in SAP) ----
//
// See ADR-0042 and sap/contract.js's note on poAssetCreate for why this is a
// deliberate, narrow exception to "the portal creates no purchase orders in
// SAP" rather than a reversal of it. Two things about the implementation are
// load-bearing:
//
// 1. **SAP first, then persist.** The order is created in SAP, and only the
//    number SAP returns is written locally. There is no local-first path and
//    no fallback: if SAP refuses, nothing is saved. The alternative — recording
//    the order and reconciling later — is exactly the "order the portal thinks
//    exists but SAP has never heard of" state §5.6 spent a phase removing.
//
// 2. **The asset number is the operator's, not ours.** The portal holds no
//    asset master, so nothing here can tell a valid ANLN1 from a typo that
//    happens to be twelve digits. It is validated for *shape* only and passed
//    through verbatim; the audit log records who submitted it, because that is
//    the only accountability available.
const createAssetPo = asyncHandler(async (req, res, next) => {
  const body = req.body;

  // The vendor has to exist here, be approved, and carry an SAP vendor code.
  // SAP will reject an unknown LIFNR anyway, but failing here means the
  // supplier's own name is in the error rather than an SAP message quoting a
  // code the operator never typed.
  const vendor = await prisma.vendor.findFirst({ where: { vendorId: body.vendorId } });
  if (!vendor) {
    return next(ApiError.notFound(`Vendor ${body.vendorId} not found`));
  }
  if (vendor.status !== 'Approved') {
    return next(ApiError.badRequest(`${vendor.companyName} is ${vendor.status}, not Approved — an asset purchase order can only be raised against an approved supplier`));
  }
  if (!vendor.sapVendorCode) {
    return next(ApiError.badRequest(`${vendor.companyName} has no SAP vendor master yet — approve the supplier so XK01 runs before raising an order against them`));
  }

  const order = {
    companyCode: body.companyCode,
    purchasingOrg: body.purchasingOrg,
    purchasingGroup: body.purchasingGroup,
    docType: body.docType,
    paymentTerms: body.paymentTerms,
    currency: body.currency,
    docDate: body.docDate || new Date().toISOString(),
  };

  // netValue divides by priceUnit (PEINH) — SAP's NETPR is the price for that
  // many units, not for one. This used to be `quantity * unitPrice`, which
  // overstated any line with a price unit other than 1 by exactly that factor
  // (issue #108). The arithmetic is shared with the form that previews it.
  const items = body.items.map((item, index) => ({
    ...item,
    line: (index + 1) * 10,
    netValue: lineNetValue(item),
  }));

  // SAP first. A driver that cannot do this (the ECC skeleton) throws
  // not_implemented and nothing is written, which is the correct outcome —
  // better no order than a local one claiming an SAP document that was never
  // created.
  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.poAssetCreate({ vendor, order, items });

  // nextSequentialId hands out numbers from an atomic per-tenant counter, not a
  // scan of existing rows, so this needs no createWithUniqueId retry — same as
  // awardRfq (rfq.controller.js), which allocates PO ids the same way.
  const poId = await nextSequentialId('purchaseOrder', `PO-${new Date().getFullYear()}-`, 4);
  const po = await prisma.purchaseOrder.create({
      data: {
        id: poId,
        // The real number SAP issued — never generated here. This is the whole
        // difference between this method and the poProvision it is allowed to
        // exist alongside.
        sapPoNumber: result.sapPoNumber,
        sapDocNumber: result.sapPoNumber,
        // Not 'pending': unlike an awarded order waiting to be correlated
        // against SAP's ledger, this order IS SAP's, from the moment it was
        // created. sweepPurchaseOrders skips a synced order it rediscovers
        // (it matches on sapPoNumber), so this also stops the sweep creating
        // a duplicate local record for it later.
        sapSyncState: 'synced',
        sapSyncedAt: new Date(),
        vendorId: vendor.vendorId,
        vendorPk: vendor.pk,
        // req.account was never set by anything — protect() attaches req.user
        // (tenant staff) / req.vendor (suppliers) and req.auth (email, role,
        // plane). Optional chaining let this fail silently: every asset PO
        // recorded a null buyer (issue #112). po:manage is never held by a
        // supplier, so req.user is always the caller here; req.auth.email is
        // the fallback the original name || email intended.
        buyerName: req.user?.name || req.auth?.email || null,
        companyCode: order.companyCode,
        purchasingOrg: order.purchasingOrg,
        purchasingGroup: order.purchasingGroup,
        docType: order.docType || 'NB',
        paymentTerms: order.paymentTerms || null,
        currency: order.currency,
        deliveryAddress: body.deliveryAddress || null,
        status: 'Open',
        items: {
          create: items.map((item) => ({
            // Tenant-stamped explicitly: a nested create does not re-enter the
            // tenant extension (§5.5).
            clientId: req.clientId,
            line: item.line,
            // An asset line is text-only — SAP took SHORT_TEXT and no MATNR.
            // '' rather than null keeps it identical to what
            // zpo_grn_vendor/Detail returns for a text line, and to what
            // sweepPurchaseOrders already stores for one.
            materialCode: '',
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            netValue: item.netValue,
            uom: item.uom,
            plant: item.plant,
            storageLocation: item.storageLocation || null,
            materialGroup: item.materialGroup || null,
            taxCode: item.taxCode || null,
            assetNumber: item.assetNumber,
            assetSubNumber: item.assetSubNumber,
            // What this order *is*, in SAP's terms. zasset_po/create posts with
            // account assignment A by definition, so the category is known here
            // without reading it back — and recording it now means an asset PO
            // is identifiable the same way whether the portal raised it or the
            // sweep discovered it (jobs/handlers/sweepPurchaseOrders.js).
            accountAssignmentCategory: 'A',
            // Stored, not just forwarded to SAP: without it netValue cannot be
            // re-derived or reconciled against SAP's own copy (issue #108).
            priceUnit: item.priceUnit,
          })),
        },
      },
      include: { items: { orderBy: { line: 'asc' } } },
  });

  const io = req.app.get('io');
  emitToProcurement(io, req.clientId, EVENTS.PO_NEW, { id: po.id, sapPoNumber: po.sapPoNumber, vendorId: po.vendorId });
  emitToVendor(io, req.clientId, po.vendorId, EVENTS.PO_NEW, { id: po.id, sapPoNumber: po.sapPoNumber });

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.PO_ASSET_CREATE,
    target: { type: 'PurchaseOrder', id: po.id, label: po.sapPoNumber },
    meta: {
      sapPoNumber: po.sapPoNumber,
      vendorId: po.vendorId,
      companyCode: po.companyCode,
      // Recorded because nothing else can verify it — see this section's header.
      assets: items.map((item) => ({ line: item.line, assetNumber: item.assetNumber, assetSubNumber: item.assetSubNumber })),
      totalValue: items.reduce((sum, item) => sum + item.netValue, 0),
    },
  });

  res.status(201).json({
    message: `Asset purchase order ${result.sapPoNumber} created in SAP`,
    po: formatPo(po),
  });
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
    quantity: toQty(item.quantity),
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

// The one sequence that actually commits a plan: tell SAP, then persist —
// shared by a buyer's direct edit (configureInvoicePlan) and an approved
// supplier proposal (approveInvoicePlanChange), so the two paths cannot drift
// apart on what "saving a plan" means. Order matters: an order whose plan was
// recorded here but never reached SAP is the one state nobody can reconcile
// afterwards, so the SAP call happens first and a driver that cannot make it
// (the ECC skeleton) throws rather than the write silently diverging.
const applyInvoicePlan = async ({ req, po, item, plan }) => {
  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.poInvoicePlanUpdate({ po: formatPo(po), item: { ...item, invoicePlan: plan }, plan });
  if (result?.planNumber) plan.planNumber = result.planNumber;

  const savedPlan = await persistInvoicePlan(item, plan);

  const io = req.app.get('io');
  if (result?.transaction) {
    emitToVendor(io, req.clientId, po.vendorId, EVENTS.LOG_NEW, { type: result.transaction.type, name: result.transaction.code });
  }

  return savedPlan;
};

// @desc    Every invoicing plan on this purchase order, with what is billable now
// @route   GET /api/pos/:id/invoice-plan
// @access  Private (po:read)
const getInvoicePlan = asyncHandler(async (req, res, next) => {
  // po:read is also what a supplier holds, and nothing else here was checking
  // whose order this is — scopedWhere is a no-op for tenant staff (no
  // scopeVendorId) and confines a supplier caller to their own PO, the same
  // guarantee acknowledgePO/submitASN already give this resource family.
  const po = await prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: PO_INCLUDE });
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

  const savedPlan = await applyInvoicePlan({ req, po, item, plan });

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
  const formattedPo = formatPo(po);

  // poInvoicePlanDisplay reads one FPLA plan number at a time and can only ask
  // about lines that already carry one, so on its own a sync could never find a
  // plan the portal had not written itself — a plan configured directly in
  // ME22N stayed invisible no matter how many times a buyer pressed Sync. Ask
  // the order which plans SAP holds first, and the display read has something to
  // ask about.
  //
  // Degrading quietly is deliberate: a driver without this read (the ECC
  // skeleton throws not_implemented) still syncs exactly as well as it did
  // before, which is to say for plans the portal already knows.
  try {
    const { lines = [] } = await sap.poInvoicePlanNumbers({ po: formattedPo });
    for (const { line, planNumber } of lines) {
      // This read now answers for every line, not only planned ones (it also
      // carries the account assignment category), so an unplanned line has to
      // be skipped here rather than by the driver.
      if (!planNumber) continue;
      const item = (formattedPo.items || []).find((candidate) => Number(candidate.line) === Number(line));
      if (!item || item.invoicePlan?.planNumber) continue;
      item.invoicePlan = { ...(item.invoicePlan || {}), enabled: true, planNumber };
    }
  } catch (error) {
    req.log?.warn?.({ err: error, poId: po.id }, 'Invoicing plan number discovery unavailable; syncing known plans only');
  }

  const { plans = [] } = await sap.poInvoicePlanDisplay({ po: formattedPo });

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

// --- A supplier's proposed change to a plan already on their own PO --------
//
// Everything above this line writes SAP the moment a buyer submits it — that
// is what po:manage means. A supplier holds po:invoice-plan:propose instead,
// which reaches only these three routes and never sap.poInvoicePlanUpdate
// directly: what a supplier submits here is stored as InvoicePlan.pendingChange
// and only takes effect once approveInvoicePlanChange (po:manage) applies it.

// @desc    Propose a change to the invoicing plan on one of the caller's own
//          PO line items — stored for the buyer to approve, never applied here
// @route   PUT /api/pos/:id/items/:line/invoice-plan/propose
// @access  Private (po:invoice-plan:propose — a supplier, on their own PO)
const proposeInvoicePlanChange = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const po = await prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const item = findPlanItem(po, req.params.line);
  if (!item.invoicePlan?.enabled) {
    return next(ApiError.badRequest(`Line ${item.line} has no invoicing plan for you to propose a change to`));
  }

  const existingPlan = formatPlan(item.invoicePlan);

  // Validated now, against today's plan, so a malformed proposal is refused
  // with a sentence the supplier can act on rather than being stored and
  // failing silently at approval. The built plan itself is discarded —
  // req.body is what gets stored, and is rebuilt fresh (against whatever the
  // plan looks like by then) when a buyer approves it. See applyInvoicePlan's
  // header and the InvoicePlan.pendingChange comment in schema.prisma.
  try {
    // A supplier moves dates on the plan that exists; it is not theirs to restructure.
    assertDatesOnlyChange(req.body, existingPlan);
    buildPlan(req.body, { item, currency: po.currency || 'INR', existingPlan });
  } catch (error) {
    if (error instanceof InvoicePlanError) return next(ApiError.badRequest(error.message));
    throw error;
  }

  const pendingChange = { input: req.body, requestedAt: new Date().toISOString(), requestedBy: vendorId };
  const updatedPlan = await prisma.invoicePlan.update({
    where: { pk: item.invoicePlan.pk },
    data: { pendingChange },
    include: { lines: true },
  });

  await recordAudit({
    action: AUDIT_ACTIONS.PO_INVOICE_PLAN_CHANGE_REQUESTED,
    req,
    target: { type: 'PurchaseOrder', id: po.id, label: po.sapPoNumber || po.id },
    meta: { line: item.line, proposed: req.body },
  });

  const io = req.app.get('io');
  emitToProcurement(io, req.clientId, EVENTS.LOG_NEW, {
    type: 'invoice_plan_change_requested', name: `${po.id} line ${item.line}`,
  });

  res.json({
    message: `Proposed change sent for line ${item.line} — your buyer must approve it before it reaches SAP`,
    item: planItemView({ ...item, invoicePlan: updatedPlan }, new Date()),
  });
});

// @desc    Approve a supplier's proposed invoicing-plan change and apply it —
//          the only place a supplier's proposal reaches SAP
// @route   PUT /api/pos/:id/items/:line/invoice-plan/propose/approve
// @access  Private (po:manage)
const approveInvoicePlanChange = asyncHandler(async (req, res, next) => {
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const item = findPlanItem(po, req.params.line);
  const pending = item.invoicePlan?.pendingChange;
  if (!pending) {
    return next(ApiError.badRequest(`Line ${item.line} has no proposed invoicing-plan change awaiting approval`));
  }

  const existingPlan = formatPlan(item.invoicePlan);

  // Rebuilt now, against the plan as it stands today — not the snapshot
  // buildPlan validated at proposal time. Anything invoiced since the
  // proposal was made is carried forward exactly as a buyer's own edit would;
  // a proposal that no longer reconciles (the item's value changed, say) is
  // refused rather than silently applied wrong.
  let plan;
  try {
    plan = buildPlan(pending.input, { item, currency: po.currency || 'INR', existingPlan });
  } catch (error) {
    if (error instanceof InvoicePlanError) {
      return next(ApiError.badRequest(`This proposal no longer applies cleanly: ${error.message}. Ask the supplier to resubmit it.`));
    }
    throw error;
  }

  const savedPlan = await applyInvoicePlan({ req, po, item, plan });

  await recordAudit({
    action: AUDIT_ACTIONS.PO_INVOICE_PLAN_CHANGE_APPROVED,
    req,
    target: { type: 'PurchaseOrder', id: po.id, label: po.sapPoNumber || po.id },
    meta: { line: item.line, proposedBy: pending.requestedBy, applied: pending.input },
  });

  res.json({
    message: `Proposed change for line ${item.line} approved and saved to SAP`,
    item: planItemView({ ...item, invoicePlan: savedPlan }, new Date()),
  });
});

// @desc    Reject a supplier's proposed invoicing-plan change — the live plan
//          is left exactly as it was
// @route   PUT /api/pos/:id/items/:line/invoice-plan/propose/reject
// @access  Private (po:manage)
const rejectInvoicePlanChange = asyncHandler(async (req, res, next) => {
  const { reason } = req.body;
  const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  const item = findPlanItem(po, req.params.line);
  const pending = item.invoicePlan?.pendingChange;
  if (!pending) {
    return next(ApiError.badRequest(`Line ${item.line} has no proposed invoicing-plan change awaiting approval`));
  }

  const updatedPlan = await prisma.invoicePlan.update({
    where: { pk: item.invoicePlan.pk },
    data: { pendingChange: null },
    include: { lines: true },
  });

  await recordAudit({
    action: AUDIT_ACTIONS.PO_INVOICE_PLAN_CHANGE_REJECTED,
    req,
    target: { type: 'PurchaseOrder', id: po.id, label: po.sapPoNumber || po.id },
    meta: { line: item.line, proposedBy: pending.requestedBy, proposed: pending.input, reason },
  });

  res.json({
    message: `Proposed change for line ${item.line} rejected`,
    item: planItemView({ ...item, invoicePlan: updatedPlan }, new Date()),
  });
});

module.exports = {
  getPOs,
  getPOById,
  acknowledgePO,
  submitASN,
  getASNForPO,
  getASNs,
  getSapPoStatus,
  createAssetPo,
  getInvoicePlan,
  configureInvoicePlan,
  removeInvoicePlan,
  setInvoicePlanLineBlock,
  syncInvoicePlan,
  proposeInvoicePlanChange,
  approveInvoicePlanChange,
  rejectInvoicePlanChange,
};
