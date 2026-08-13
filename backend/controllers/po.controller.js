const PurchaseOrder = require('../models/PurchaseOrder');
const ASN = require('../models/ASN');
const GRN = require('../models/GRN');
const Vendor = require('../models/Vendor');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');

const { requireVendorScope, withVendorScope } = require('../utils/requestScope');

// @desc    Get POs
// @route   GET /api/pos
// @access  Public
const getPOs = asyncHandler(async (req, res, next) => {
  const { status, page = 1, limit = 10 } = req.query;

  const query = withVendorScope(req);
  if (status) {
    query.status = status;
  }

  const skip = (page - 1) * limit;
  const pos = await PurchaseOrder.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await PurchaseOrder.countDocuments(query);

  res.json({
    pos,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Get PO by ID
// @route   GET /api/pos/:id
// @access  Public
const getPOById = asyncHandler(async (req, res, next) => {
  const po = await PurchaseOrder.findOne({ id: req.params.id });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }
  res.json(po);
});

// @desc    Acknowledge PO
// @route   PUT /api/pos/:id/acknowledge
// @access  Public
const acknowledgePO = asyncHandler(async (req, res, next) => {
  const po = await PurchaseOrder.findOne({ id: req.params.id });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  if (po.status !== 'Open') {
    return next(ApiError.badRequest(`Purchase Order cannot be acknowledged in '${po.status}' state`));
  }

  po.status = 'Acknowledged';
  po.acknowledgedAt = new Date();
  await po.save();

  const sap = await getSapAdapterForClient(req.clientId);
  const { transaction } = await sap.poAcknowledge({ po });

  const io = req.app.get('io');
  emitToVendor(io, req.clientId, po.vendorId, EVENTS.LOG_NEW, { type: transaction.type, name: transaction.code });

  res.json({ message: 'Purchase Order acknowledged successfully', po });
});

// @desc    Simulate PO creation from SAP
// @route   POST /api/pos/simulate
// @access  Public
const simulatePO = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await Vendor.findOne({ $or: [{ vendorId }, { clerkId: vendorId }] });

  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const lastPo = await PurchaseOrder.findOne({ id: new RegExp('^' + prefix) }).sort({ id: -1 });
  let seq = 1;
  if (lastPo) {
    const match = lastPo.id.match(/-(\d+)$/);
    if (match) {
      seq = parseInt(match[1]) + 1;
    }
  }
  const poId = `${prefix}${String(seq).padStart(4, '0')}`;

  // The purchase order's contents come from SAP; the business id is ours,
  // because it has to be unique within this tenant and SAP knows nothing about
  // tenants.
  const sap = await getSapAdapterForClient(req.clientId);
  const { sapPoNumber, buyerName, plant, paymentTerms, currency, deliveryAddress, items } =
    await sap.poProvision({ vendorId });

  const po = await PurchaseOrder.create({
    id: poId,
    sapPoNumber,
    vendorId,
    vendorDbId: vendor ? vendor._id : null,
    buyerName,
    plant,
    paymentTerms,
    currency,
    deliveryAddress,
    status: 'Open',
    items
  });

  const { transaction } = await sap.poProvisioned({ po, vendorId });

  const io = req.app.get('io');
  emitToVendor(io, req.clientId, vendorId, EVENTS.PO_NEW, po);
  emitToVendor(io, req.clientId, vendorId, EVENTS.LOG_NEW, { type: transaction.type, name: transaction.code });

  res.status(201).json(po);
});

// @desc    Submit ASN (Advanced Shipping Notification)
// @route   POST /api/pos/:id/asn
// @access  Public
const submitASN = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { carrierName, trackingNumber, vehicleNumber, invoiceReference, ewayBillNo, shipDate, estimatedDeliveryDate, items, documentIds } = req.body;

  if (!items || !items.length) {
    return next(ApiError.badRequest('ASN items are required'));
  }

  const po = await PurchaseOrder.findOne({ id: req.params.id });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  if (po.status !== 'Acknowledged') {
    return next(ApiError.badRequest(`Cannot dispatch / create ASN for PO in status '${po.status}'. Must be Acknowledged first.`));
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

  const asnId = 'ASN-' + Math.floor(100000 + Math.random() * 900000);
  const io = req.app.get('io');
  const { clientId } = req;
  const sap = await getSapAdapterForClient(clientId);

  // SAP issues the inbound delivery number, so the ASN is announced to it
  // before it is stored rather than being stamped with a number we invented.
  const delivery = await sap.deliveryCreate({
    asn: {
      id: asnId,
      shipDate: shipDate ? new Date(shipDate) : new Date(),
      carrierName,
      trackingNumber,
      items: validatedItems
    },
    po,
    vendorId
  });

  const asn = await ASN.create({
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
    documentIds: documentIds || [],
    sapInboundDelivery: delivery.sapInboundDelivery,
    items: validatedItems
  });

  // Update PO status to Dispatched
  po.status = 'Dispatched';
  await po.save();

  emitToVendor(io, clientId, vendorId, EVENTS.LOG_NEW, { type: delivery.transaction.type, name: delivery.transaction.code });

  // The goods receipt arrives when SAP says it does — ten seconds on the
  // simulator, a webhook or a poll on a real system. Either way this handler is
  // what we do with it, and the adapter has already re-bound the tenant.
  const onCall = ({ code, type }) => emitToVendor(io, clientId, vendorId, EVENTS.LOG_NEW, { type, name: code });

  sap.awaitGoodsReceipt({ asn, po, vendorId, onCall }, async (receipt) => {
    const latestPo = await PurchaseOrder.findOne({ id: po.id });
    const latestAsn = await ASN.findOne({ id: asn.id });

    // The receipt is only applied if the shipment is still awaiting one — a
    // cancelled or already-received ASN must not gain a second GRN.
    if (!latestPo || !latestAsn || latestAsn.status !== 'Submitted') return null;

    const grn = await GRN.create({
      id: receipt.grnId,
      poId: latestPo.id,
      asnId: latestAsn.id,
      vendorId: latestAsn.vendorId,
      sapMigoDoc: receipt.sapMigoDoc,
      postingDate: receipt.postingDate,
      receivedBy: receipt.receivedBy,
      invoiceSubmitted: false,
      items: receipt.items
    });

    latestAsn.status = 'Received';
    await latestAsn.save();

    latestPo.status = 'Delivered';
    receipt.items.forEach(gItem => {
      const poItem = latestPo.items.find(pItem => pItem.line === gItem.line);
      if (poItem) {
        poItem.grnQuantity += gItem.acceptedQuantity;
      }
    });
    await latestPo.save();

    emitToVendor(io, clientId, latestAsn.vendorId, EVENTS.GRN_RECEIVED, grn);

    return grn;
  });

  res.status(201).json({ message: 'ASN submitted successfully. Goods receipt will follow from SAP.', asn });
});

// @desc    Get ASN for PO
// @route   GET /api/pos/:id/asn
// @access  Public
const getASNForPO = asyncHandler(async (req, res, next) => {
  const asns = await ASN.find({ poId: req.params.id });
  res.json(asns);
});

// @desc    Get all ASNs for current vendor
// @route   GET /api/asns
// @access  Public
const getASNs = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const asns = await ASN.find({ vendorId }).sort({ createdAt: -1 });
  res.json(asns);
});

// @desc    Update PO status
// @route   PUT /api/pos/:id/status
// @access  Public
const updatePOStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  if (!status) {
    return next(ApiError.badRequest('Status is required'));
  }

  const po = await PurchaseOrder.findOne({ id: req.params.id });
  if (!po) {
    return next(ApiError.notFound('Purchase Order not found'));
  }

  po.status = status;
  await po.save();

  res.json({ message: 'PO status updated successfully', po });
});

module.exports = {
  getPOs,
  getPOById,
  acknowledgePO,
  simulatePO,
  submitASN,
  getASNForPO,
  getASNs,
  updatePOStatus
};
