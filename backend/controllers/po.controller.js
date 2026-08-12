const PurchaseOrder = require('../models/PurchaseOrder');
const ASN = require('../models/ASN');
const GRN = require('../models/GRN');
const Vendor = require('../models/Vendor');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { createSapLog } = require('../utils/sapLogger');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');
const { runWithTenant } = require('../utils/tenantContext');

// Helper to determine vendor ID
const getVendorId = (req) => {
  return req.clerkUserId || req.headers['x-vendor-id'] || 'mock_vendor_id';
};

// @desc    Get POs
// @route   GET /api/pos
// @access  Public
const getPOs = asyncHandler(async (req, res, next) => {
  const vendorId = req.clerkUserId || req.headers['x-vendor-id'];
  const { status, page = 1, limit = 10 } = req.query;

  let query = {};
  if (vendorId) {
    query.vendorId = vendorId;
  }
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

  await createSapLog({
    vendorId: po.vendorId,
    type: 'RFC',
    direction: 'OUTBOUND',
    name: 'RFC_PO_ACKNOWLEDGE',
    payload: { poId: po.id, acknowledgedAt: po.acknowledgedAt },
    status: 'SUCCESS',
    documentRef: po.id
  });

  const io = req.app.get('io');
  emitToVendor(io, req.clientId, po.vendorId, EVENTS.LOG_NEW, { type: 'RFC', name: 'RFC_PO_ACKNOWLEDGE' });

  res.json({ message: 'Purchase Order acknowledged successfully', po });
});

// @desc    Simulate PO creation from SAP
// @route   POST /api/pos/simulate
// @access  Public
const simulatePO = asyncHandler(async (req, res, next) => {
  const vendorId = getVendorId(req);
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

  const randomMaterials = [
    { code: 'MAT-3849', desc: 'Steel Pipe 3" SCH40' },
    { code: 'MAT-9210', desc: 'Flange 3" ANSI 150#' },
    { code: 'MAT-5531', desc: 'Hex Bolt M12x50 Grade 8.8' },
    { code: 'MAT-1029', desc: 'Gasket 3" Non-Asbestos' }
  ];
  const material = randomMaterials[Math.floor(Math.random() * randomMaterials.length)];
  const qty = Math.floor(100 + Math.random() * 900);
  const price = Math.floor(50 + Math.random() * 450);

  const po = await PurchaseOrder.create({
    id: poId,
    sapPoNumber: '4500' + Math.floor(100000 + Math.random() * 900000),
    vendorId,
    vendorDbId: vendor ? vendor._id : null,
    buyerName: 'SAP Buyer System',
    plant: '1000',
    paymentTerms: 'NET 30 Days',
    currency: 'INR',
    deliveryAddress: 'Plant 1000 Main Warehouse, Mumbai',
    status: 'Open',
    items: [{
      line: 10,
      materialCode: material.code,
      description: material.desc,
      quantity: qty,
      grnQuantity: 0,
      unitPrice: price,
      netValue: price * qty,
      uom: 'EA'
    }]
  });

  await createSapLog({
    vendorId,
    type: 'OData',
    direction: 'INBOUND',
    name: '/API_PURCHASEORDER_PROCESS_SRV',
    payload: po,
    status: 'SUCCESS',
    documentRef: po.id
  });

  const io = req.app.get('io');
  emitToVendor(io, req.clientId, vendorId, EVENTS.PO_NEW, po);
  emitToVendor(io, req.clientId, vendorId, EVENTS.LOG_NEW, { type: 'OData', name: '/API_PURCHASEORDER_PROCESS_SRV' });

  res.status(201).json(po);
});

// @desc    Submit ASN (Advanced Shipping Notification)
// @route   POST /api/pos/:id/asn
// @access  Public
const submitASN = asyncHandler(async (req, res, next) => {
  const vendorId = getVendorId(req);
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
    sapInboundDelivery: '180' + Math.floor(1000000 + Math.random() * 9000000),
    items: validatedItems
  });

  // Update PO status to Dispatched
  po.status = 'Dispatched';
  await po.save();

  // Log SAP Outbound BAPI (VL31N)
  await createSapLog({
    vendorId,
    type: 'RFC',
    direction: 'OUTBOUND',
    name: 'BAPI_DELIVERYPROCESSING_EXEC',
    payload: {
      LIKP: {
        VBELN: asn.sapInboundDelivery,
        WADAT: asn.shipDate,
        TDLNR: asn.carrierName,
        LIFEX: asn.trackingNumber
      },
      LIPS: asn.items
    },
    status: 'SUCCESS',
    documentRef: asn.id
  });

  const io = req.app.get('io');
  const { clientId } = req;
  emitToVendor(io, clientId, vendorId, EVENTS.LOG_NEW, { type: 'RFC', name: 'BAPI_DELIVERYPROCESSING_EXEC' });

  // Schedule autoCreateGRN after 10 seconds. The timer fires outside the
  // request, so the tenant context has to be re-bound explicitly.
  setTimeout(() => runWithTenant(clientId, async () => {
    try {
      console.log(`[SIMULATOR] Starting auto GRN receipt creation for PO: ${po.id}, ASN: ${asn.id}`);
      
      const latestPo = await PurchaseOrder.findOne({ id: po.id });
      const latestAsn = await ASN.findOne({ id: asn.id });

      if (latestPo && latestAsn && latestAsn.status === 'Submitted') {
        const grnId = 'GRN-1800' + Math.floor(10000 + Math.random() * 90000);
        const sapMigoDoc = 'MIGO-18' + Math.floor(100000000 + Math.random() * 900000000);

        const grnItems = latestAsn.items.map(item => {
          const received = item.shippedQuantity;
          const accepted = Math.round(received * 0.95);
          const rejected = received - accepted;
          return {
            line: item.line,
            materialCode: item.materialCode,
            description: item.description,
            receivedQuantity: received,
            acceptedQuantity: accepted,
            rejectedQuantity: rejected,
            rejectionReason: rejected > 0 ? 'Surface inspection defect / Dimensional variance' : undefined,
            uom: item.uom || 'EA'
          };
        });

        // Create GRN
        const grn = await GRN.create({
          id: grnId,
          poId: latestPo.id,
          asnId: latestAsn.id,
          vendorId: latestAsn.vendorId,
          sapMigoDoc,
          postingDate: new Date(),
          receivedBy: 'SAP Warehouse Staff',
          invoiceSubmitted: false,
          items: grnItems
        });

        // Update ASN Status to Received
        latestAsn.status = 'Received';
        await latestAsn.save();

        // Update PO Status & item grnQuantity
        latestPo.status = 'Delivered';
        grnItems.forEach(gItem => {
          const poItem = latestPo.items.find(pItem => pItem.line === gItem.line);
          if (poItem) {
            poItem.grnQuantity += gItem.acceptedQuantity;
          }
        });
        await latestPo.save();

        // Log SAP Goods Receipt (MIGO)
        await createSapLog({
          vendorId: latestAsn.vendorId,
          type: 'BAPI',
          direction: 'INBOUND',
          name: 'BAPI_GOODSMVT_CREATE',
          payload: grn,
          status: 'SUCCESS',
          documentRef: grn.id
        });

        // Log SAP GRN Sync (GETDETAIL)
        await createSapLog({
          vendorId: latestAsn.vendorId,
          type: 'RFC',
          direction: 'INBOUND',
          name: 'BAPI_GOODSMVT_GETDETAIL',
          payload: { migoDoc: grn.sapMigoDoc, items: grn.items },
          status: 'SUCCESS',
          documentRef: grn.id
        });

        emitToVendor(io, clientId, latestAsn.vendorId, EVENTS.GRN_RECEIVED, grn);
        emitToVendor(io, clientId, latestAsn.vendorId, EVENTS.LOG_NEW, { type: 'BAPI', name: 'BAPI_GOODSMVT_CREATE' });
        emitToVendor(io, clientId, latestAsn.vendorId, EVENTS.LOG_NEW, { type: 'RFC', name: 'BAPI_GOODSMVT_GETDETAIL' });

        console.log(`[SIMULATOR] Auto-generated GRN successfully: ${grn.id} for PO ${latestPo.id}`);
      }
    } catch (err) {
      console.error('[SIMULATOR] Failed to auto-generate GRN:', err);
    }
  }), 10000);

  res.status(201).json({ message: 'ASN submitted successfully. Goods receipt simulated in 10 seconds.', asn });
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
  const vendorId = getVendorId(req);
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
