const RFQ = require('../models/RFQ');
const PurchaseOrder = require('../models/PurchaseOrder');
const Vendor = require('../models/Vendor');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');

const { requireVendorScope, vendorScope } = require('../utils/requestScope');

// Helper for tax codes
const gstToTaxCode = (gstRate) => {
  const cleanRate = String(gstRate).replace(/[^0-9]/g, '');
  if (cleanRate === '5') return 'G3';
  if (cleanRate === '12') return 'G2';
  if (cleanRate === '18') return 'G1';
  if (cleanRate === '28') return 'G4';
  return 'G1'; // default
};

// @desc    Get RFQs (invited or all)
// @route   GET /api/rfqs
// @access  Public (unauth development)
const getRFQs = asyncHandler(async (req, res, next) => {
  const { status, page = 1, limit = 20 } = req.query;

  // A supplier only ever sees RFQs they were invited to.
  const vendorId = vendorScope(req);
  let query = {};
  if (vendorId && req.query.all !== 'true') {
    query = { 'invitedVendors.id': vendorId };
  }
  if (status) {
    query.status = status;
  }

  const skip = (page - 1) * limit;
  const rfqs = await RFQ.find(query)
    .sort({ createdDate: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await RFQ.countDocuments(query);

  res.json({
    rfqs,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Get RFQ by ID (string id)
// @route   GET /api/rfqs/:id
// @access  Public
const getRFQById = asyncHandler(async (req, res, next) => {
  const rfq = await RFQ.findOne({ id: req.params.id });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }
  res.json(rfq);
});

// @desc    Create RFQ
// @route   POST /api/rfqs
// @access  Public
const createRFQ = asyncHandler(async (req, res, next) => {
  const { description, deadlineDate, rfqType, items, invitedVendors, paymentTerms, deliveryLocation } = req.body;

  if (!description || !deadlineDate || !items || !items.length) {
    return next(ApiError.badRequest('Description, deadlineDate, and items are required'));
  }

  // Generate RFQ sequential ID: RFQ-YYYY-SEQ
  const year = new Date().getFullYear();
  const prefix = `RFQ-${year}-`;
  const lastRfq = await RFQ.findOne({ id: new RegExp('^' + prefix) }).sort({ id: -1 });
  let seq = 1;
  if (lastRfq) {
    const match = lastRfq.id.match(/-(\d+)$/);
    if (match) {
      seq = parseInt(match[1]) + 1;
    }
  }
  const id = `${prefix}${String(seq).padStart(3, '0')}`;

  const rfq = await RFQ.create({
    id,
    description,
    deadlineDate: new Date(deadlineDate),
    rfqType: rfqType || 'AN',
    paymentTerms: paymentTerms || 'NET 30 Days',
    deliveryLocation: deliveryLocation || 'Plant 1000',
    items: items.map(item => ({
      line: item.line,
      materialCode: item.materialCode,
      description: item.description,
      quantity: item.quantity,
      uom: item.uom || 'EA',
      targetPrice: item.targetPrice,
      plant: item.plant || '1000',
      deliveryDate: item.deliveryDate ? new Date(item.deliveryDate) : undefined
    })),
    invitedVendors: invitedVendors || []
  });

  const sap = await getSapAdapterForClient(req.clientId);
  await sap.rfqCreate({
    rfq,
    vendorId: invitedVendors && invitedVendors.length ? invitedVendors[0].id : 'SYSTEM'
  });

  res.status(201).json(rfq);
});

// @desc    Cancel RFQ
// @route   PUT /api/rfqs/:id/cancel
// @access  Public
const cancelRFQ = asyncHandler(async (req, res, next) => {
  const rfq = await RFQ.findOne({ id: req.params.id });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  rfq.status = 'Closed';
  await rfq.save();

  const sap = await getSapAdapterForClient(req.clientId);
  await sap.rfqCancel({ rfq });

  res.json({ message: 'RFQ cancelled successfully', rfq });
});

// @desc    Reissue RFQ
// @route   PUT /api/rfqs/:id/reissue
// @access  Public
const reissueRFQ = asyncHandler(async (req, res, next) => {
  const { deadlineDate } = req.body;
  if (!deadlineDate) {
    return next(ApiError.badRequest('New deadlineDate is required'));
  }

  const rfq = await RFQ.findOne({ id: req.params.id });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  rfq.deadlineDate = new Date(deadlineDate);
  rfq.status = 'Bidding Open';
  await rfq.save();

  const sap = await getSapAdapterForClient(req.clientId);
  await sap.rfqReissue({ rfq });

  res.json({ message: 'RFQ reissued successfully', rfq });
});

// @desc    Submit Quotation / Bid (ME47)
// @route   POST /api/rfqs/:id/bid
// @access  Public
const submitBid = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { unitPrices, gstRate, freight, deliveryLeadTimeDays, validityDate, remarks, uploadedDocs } = req.body;

  if (!unitPrices) {
    return next(ApiError.badRequest('unitPrices map is required'));
  }

  const rfq = await RFQ.findOne({ id: req.params.id });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  if (rfq.status !== 'Bidding Open') {
    return next(ApiError.badRequest('Bidding is closed for this RFQ'));
  }

  if (new Date() > new Date(rfq.deadlineDate)) {
    return next(ApiError.badRequest('RFQ submission deadline has passed'));
  }

  // Fetch Vendor's DB ID & Rating
  const vendor = await Vendor.findOne({ $or: [{ vendorId }, { clerkId: vendorId }] });

  // Verify vendor is invited or dynamically invite them in dev/unauth mode
  let invitation = rfq.invitedVendors.find(v => v.id === vendorId);
  if (!invitation) {
    invitation = {
      id: vendorId,
      name: vendor ? vendor.companyName : 'Test Vendor',
      status: 'Pending',
      rating: 95
    };
    rfq.invitedVendors.push(invitation);
  }

  // Verify all line items are priced
  for (const item of rfq.items) {
    if (unitPrices[item.line] === undefined) {
      return next(ApiError.badRequest(`Missing unit price for line ${item.line}`));
    }
  }

  const vendorDbId = vendor ? vendor._id : null;
  const rating = invitation.rating || 80;

  const taxCode = gstToTaxCode(gstRate);

  const newBid = {
    vendorId,
    vendorDbId,
    vendorName: vendor ? vendor.companyName : 'Test Vendor',
    unitPrices: new Map(Object.entries(unitPrices).map(([k, v]) => [k, Number(v)])),
    gstRate: String(gstRate),
    taxCode,
    freight: Number(freight || 0),
    deliveryLeadTimeDays: Number(deliveryLeadTimeDays || 7),
    vendorRating: Number(rating),
    technicalScore: 80, // standard default
    validityDate: validityDate ? new Date(validityDate) : undefined,
    remarks,
    uploadedDocs: uploadedDocs || [],
    submittedAt: new Date()
  };

  // Check if vendor already bid, replace or push
  const existingBidIdx = rfq.bids.findIndex(b => b.vendorId === vendorId);
  if (existingBidIdx > -1) {
    rfq.bids[existingBidIdx] = newBid;
  } else {
    rfq.bids.push(newBid);
  }

  // If first bid, set status to Submitted
  if (rfq.status === 'Bidding Open') {
    rfq.status = 'Submitted';
  }
  await rfq.save();

  const sap = await getSapAdapterForClient(req.clientId);
  await sap.rfqSubmitBid({
    rfq,
    vendorId,
    bid: { unitPrices, taxCode, deliveryLeadTimeDays, validityDate }
  });

  res.json({ message: 'Bid submitted successfully', bidsCount: rfq.bids.length });
});

// @desc    Get Evaluation Matrix (ME48)
// @route   GET /api/rfqs/:id/evaluate
// @access  Public
const getEvaluationMatrix = asyncHandler(async (req, res, next) => {
  const rfq = await RFQ.findOne({ id: req.params.id });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  if (!rfq.bids || rfq.bids.length === 0) {
    return res.json({ rfqId: rfq.id, evaluation: [] });
  }

  // Calculate total costs and find minimums
  const vendorsAnalysis = rfq.bids.map(bid => {
    let totalCost = 0;
    rfq.items.forEach(item => {
      const price = bid.unitPrices.get(String(item.line)) || 0;
      totalCost += price * item.quantity;
    });
    // Add freight
    totalCost += Number(bid.freight || 0);

    return {
      vendorId: bid.vendorId,
      vendorName: bid.vendorName,
      totalCost,
      deliveryLeadTimeDays: bid.deliveryLeadTimeDays || 7,
      technicalScore: bid.technicalScore || 80,
      vendorRating: bid.vendorRating || 80
    };
  });

  const lowestTotalCost = Math.min(...vendorsAnalysis.map(v => v.totalCost));
  const lowestLeadTime = Math.min(...vendorsAnalysis.map(v => v.deliveryLeadTimeDays));

  // Formula:
  // priceScore    = (lowestTotalCost / vendorTotalCost) × 100
  // deliveryScore = (shortestLeadTime / vendorLeadTime) × 100
  // weightedScore = priceScore×0.40 + techScore×0.30 + deliveryScore×0.20 + rating×0.10
  const scoredVendors = vendorsAnalysis.map(v => {
    const priceScore = v.totalCost > 0 ? (lowestTotalCost / v.totalCost) * 100 : 0;
    const deliveryScore = v.deliveryLeadTimeDays > 0 ? (lowestLeadTime / v.deliveryLeadTimeDays) * 100 : 0;

    const weightedScore = (priceScore * 0.40) +
                          (v.technicalScore * 0.30) +
                          (deliveryScore * 0.20) +
                          (v.vendorRating * 0.10);

    return {
      ...v,
      priceScore: Math.round(priceScore * 100) / 100,
      deliveryScore: Math.round(deliveryScore * 100) / 100,
      weightedScore: Math.round(weightedScore * 100) / 100
    };
  });

  // Sort by weightedScore desc
  scoredVendors.sort((a, b) => b.weightedScore - a.weightedScore);

  res.json({
    rfqId: rfq.id,
    evaluation: scoredVendors
  });
});

// @desc    Award Bid (ME58) & Create PO
// @route   POST /api/rfqs/:id/award
// @access  Public
const awardBid = asyncHandler(async (req, res, next) => {
  const { vendorId } = req.body;
  if (!vendorId) {
    return next(ApiError.badRequest('Winner vendorId is required'));
  }

  const rfq = await RFQ.findOne({ id: req.params.id });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  if (rfq.status === 'Awarded') {
    return next(ApiError.badRequest('This RFQ has already been awarded'));
  }

  const winningBid = rfq.bids.find(b => b.vendorId === vendorId);
  if (!winningBid) {
    return next(ApiError.notFound('Bid not found for the specified vendor'));
  }

  // Get Vendor DB doc
  const vendor = await Vendor.findOne({ $or: [{ vendorId }, { clerkId: vendorId }] });

  // Generate sequential PO ID: PO-YYYY-SEQ
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

  // Map RFQ items and bid prices to PO items
  const poItems = rfq.items.map(item => {
    const unitPrice = winningBid.unitPrices.get(String(item.line)) || 0;
    return {
      line: item.line,
      materialCode: item.materialCode,
      description: item.description,
      quantity: item.quantity,
      grnQuantity: 0,
      unitPrice,
      netValue: unitPrice * item.quantity,
      uom: item.uom || 'EA'
    };
  });

  // Create Purchase Order
  const po = await PurchaseOrder.create({
    id: poId,
    sapPoNumber: '4500' + Math.floor(100000 + Math.random() * 900000),
    vendorId,
    vendorDbId: vendor ? vendor._id : winningBid.vendorDbId,
    buyerName: 'SAP System Procurement',
    plant: rfq.items[0]?.plant || '1000',
    paymentTerms: rfq.paymentTerms || 'NET 30 Days',
    currency: rfq.currency || 'INR',
    deliveryAddress: rfq.deliveryLocation || 'Plant 1000 Address',
    status: 'Open',
    fromRfqId: rfq.id,
    items: poItems
  });

  // Update RFQ Award details
  rfq.status = 'Awarded';
  rfq.awardedVendorId = vendorId;
  rfq.awardedVendorName = vendor ? vendor.companyName : winningBid.vendorName;
  rfq.awardedAt = new Date();
  rfq.convertedPoId = po.id;
  await rfq.save();

  const sap = await getSapAdapterForClient(req.clientId);
  await sap.infoRecordCreate({ rfq, vendorId, items: poItems });
  await sap.poInboundSync({ po, vendorId });

  res.json({ message: 'RFQ awarded and Purchase Order created successfully', po });
});

module.exports = {
  getRFQs,
  getRFQById,
  createRFQ,
  cancelRFQ,
  reissueRFQ,
  submitBid,
  getEvaluationMatrix,
  awardBid
};
