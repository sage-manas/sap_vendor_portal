const { prisma } = require('../db/prisma');
const { getTenantId } = require('../utils/tenantContext');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getSapAdapterForClient } = require('../sap');
const { EVENTS, emitToVendor } = require('../utils/socketEmitter');

const { requireVendorScope, vendorScope, isSupplier } = require('../utils/requestScope');
const { assertCanCreate } = require('../utils/usage');
const { toNumber } = require('../utils/money');
const { formatPo } = require('../db/poHelpers');
const { nextSequentialId } = require('../utils/nextSequentialId');
const { buildExportPayload, EXPORT_FORMATS } = require('../services/export.service');

// The full nested shape a controller/frontend expects an RFQ in, matching
// what the Mongoose document used to serialize as. `items`/`invitedVendors`
// are child tables now (RfqItem/RfqInvitedVendor) but map back onto plain
// arrays; `bids[].unitPrices` was a Mongoose `Map<lineNo, Number>` and is now
// its own child table (RfqBidUnitPrice) — reassembled here into the same
// `{ [line]: price }` object shape callers already expect.
const RFQ_INCLUDE = {
  items: true,
  invitedVendors: true,
  bids: { include: { unitPrices: true, uploadedDocs: true } },
};

// unitPrices[].price and freight are Decimal-typed columns — converted to
// plain numbers here, the one place every consumer (API responses, the
// evaluation matrix and awardBid's own price math below) reads a bid back
// through. See utils/money.js for why a raw Decimal can't be left in either.
const formatBid = (bid) => ({
  vendorId: bid.vendorId,
  vendorDbId: bid.vendorPk,
  vendorName: bid.vendorName,
  unitPrices: Object.fromEntries(bid.unitPrices.map((u) => [String(u.lineNumber), toNumber(u.price)])),
  gstRate: bid.gstRate,
  taxCode: bid.taxCode,
  freight: toNumber(bid.freight),
  deliveryLeadTimeDays: bid.deliveryLeadTimeDays,
  vendorRating: bid.vendorRating,
  technicalScore: bid.technicalScore,
  validityDate: bid.validityDate,
  moq: bid.moq,
  remarks: bid.remarks,
  uploadedDocs: bid.uploadedDocs.map((d) => ({ documentId: d.documentId, originalName: d.originalName, url: d.url })),
  submittedAt: bid.submittedAt,
});

// targetPrice is likewise Decimal-typed.
const formatRfqItem = ({ pk, clientId, rfqPk, targetPrice, ...item }) => ({
  ...item,
  targetPrice: toNumber(targetPrice),
});

const formatRfq = (rfq) => ({
  ...rfq,
  items: (rfq.items || []).map(formatRfqItem),
  invitedVendors: (rfq.invitedVendors || []).map((v) => ({ id: v.vendorExtId, name: v.name, status: v.status, rating: v.rating })),
  bids: (rfq.bids || []).map(formatBid),
});

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

  // A supplier only ever sees RFQs they were invited to. `?all=true` widens the
  // view for tenant staff and for them only — a supplier who asked for it used
  // to receive every RFQ in the tenant, competitors' invitations included.
  const vendorId = vendorScope(req);
  let where = {};
  if (vendorId && (isSupplier(req) || req.query.all !== 'true')) {
    where = { invitedVendors: { some: { vendorExtId: vendorId } } };
  }
  if (status) {
    where.status = status;
  }

  const skip = (page - 1) * limit;
  const [rfqs, total] = await Promise.all([
    prisma.rFQ.findMany({ where, include: RFQ_INCLUDE, orderBy: { createdDate: 'desc' }, skip, take: Number(limit) }),
    prisma.rFQ.count({ where }),
  ]);

  res.json({
    rfqs: rfqs.map(formatRfq),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    What SAP itself has issued (ME43 Display RFQ) to this vendor —
//          a cross-check against our internal RFQ tracking, not a
//          document-by-document match (our RFQs carry no SAP RFQ number).
// @route   GET /api/rfqs/sap-status
// @access  Public
const getSapRfqStatus = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  const rfqs = await prisma.rFQ.findMany({ where: { invitedVendors: { some: { vendorExtId: vendorId } } }, include: RFQ_INCLUDE });

  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.vendorRfqDisplay({ vendor, rfqs: rfqs.map(formatRfq) });

  res.json({ documents: result.documents });
});

// @desc    Every purchasing document SAP holds against this vendor's code
//          (ME48 Display Quotation). Despite the transaction name the endpoint
//          returns POs alongside quotations — see vendorQuotationDisplay in
//          sap/drivers/s4odata.driver.js — so this is presented as SAP's
//          purchasing-document ledger, with `documentType` splitting the two.
//          Read-only cross-check, like sap-status above; not matched to our
//          internal RFQ ids.
// @route   GET /api/rfqs/sap-quotations
// @access  Public
const getSapQuotationStatus = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const vendor = await prisma.vendor.findFirst({ where: { vendorId } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  // Without a vendor code the underlying SAP endpoint returns every document
  // in the client, for every supplier. Stop here rather than let that be
  // asked for — the driver guards it too, but this vendor genuinely has
  // nothing to show until SAP has given them a code.
  if (!String(vendor.sapVendorCode || '').trim()) {
    return res.json({ documents: [] });
  }

  // The mock driver has no database of its own; the real one keys off the
  // vendor code alone and ignores both of these.
  const [rfqs, pos] = await Promise.all([
    prisma.rFQ.findMany({ where: { invitedVendors: { some: { vendorExtId: vendorId } } }, include: RFQ_INCLUDE }),
    prisma.purchaseOrder.findMany({ where: { vendorId }, include: { items: true } }),
  ]);

  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.vendorQuotationDisplay({ vendor, rfqs: rfqs.map(formatRfq), pos });

  const { type } = req.query;
  const documents = type
    ? result.documents.filter((doc) => doc.documentType === type)
    : result.documents;

  res.json({ documents });
});

// @desc    Get RFQ by ID (string id)
// @route   GET /api/rfqs/:id
// @access  Public
const getRFQById = asyncHandler(async (req, res, next) => {
  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id }, include: RFQ_INCLUDE });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }
  res.json(formatRfq(rfq));
});

// @desc    Create RFQ
// @route   POST /api/rfqs
// @access  Public
const createRFQ = asyncHandler(async (req, res, next) => {
  const { description, deadlineDate, rfqType, items, invitedVendors, paymentTerms, deliveryLocation } = req.body;

  if (!description || !deadlineDate || !items || !items.length) {
    return next(ApiError.badRequest('Description, deadlineDate, and items are required'));
  }

  await assertCanCreate(req.client, 'rfqsPerMonth');

  const year = new Date().getFullYear();
  const id = await nextSequentialId('rFQ', `RFQ-${year}-`, 3);

  // items/invitedVendors are nested writes — Prisma Client Extensions do not
  // re-intercept a nested `create`, so clientId must be stamped explicitly
  // here (see backend/db/tenantExtension.js's note on this). The top-level
  // RFQ row itself still gets clientId injected automatically.
  const clientId = getTenantId();
  const rfq = await prisma.rFQ.create({
    data: {
      id,
      description,
      deadlineDate: new Date(deadlineDate),
      rfqType: rfqType || 'AN',
      paymentTerms: paymentTerms || 'NET 30 Days',
      deliveryLocation: deliveryLocation || 'Plant 1000',
      items: {
        create: items.map((item) => ({
          clientId,
          line: item.line,
          materialCode: item.materialCode,
          description: item.description,
          quantity: item.quantity,
          uom: item.uom || 'EA',
          targetPrice: item.targetPrice,
          plant: item.plant || '1000',
          deliveryDate: item.deliveryDate ? new Date(item.deliveryDate) : null,
        })),
      },
      invitedVendors: {
        create: (invitedVendors || []).map((v) => ({
          clientId,
          vendorExtId: v.id,
          name: v.name,
          status: v.status || 'Pending',
          rating: v.rating,
        })),
      },
    },
    include: RFQ_INCLUDE,
  });

  res.status(201).json(formatRfq(rfq));
});

// @desc    Cancel RFQ
// @route   PUT /api/rfqs/:id/cancel
// @access  Public
const cancelRFQ = asyncHandler(async (req, res, next) => {
  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id } });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  const updated = await prisma.rFQ.update({ where: { pk: rfq.pk }, data: { status: 'Closed' }, include: RFQ_INCLUDE });
  res.json({ message: 'RFQ cancelled successfully', rfq: formatRfq(updated) });
});

// @desc    Reissue RFQ
// @route   PUT /api/rfqs/:id/reissue
// @access  Public
const reissueRFQ = asyncHandler(async (req, res, next) => {
  const { deadlineDate } = req.body;
  if (!deadlineDate) {
    return next(ApiError.badRequest('New deadlineDate is required'));
  }

  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id } });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  const updated = await prisma.rFQ.update({
    where: { pk: rfq.pk },
    data: { deadlineDate: new Date(deadlineDate), status: 'Bidding Open' },
    include: RFQ_INCLUDE,
  });
  res.json({ message: 'RFQ reissued successfully', rfq: formatRfq(updated) });
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

  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id }, include: { items: true, invitedVendors: true } });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  // A supplier absent from the invitee list gets the same 404 as a tender in
  // another tenant — the API must not confirm a sealed tender exists (or leak
  // its status/deadline/line structure) to a non-participant (see cross-tenant
  // isolation convention).
  const invitation = rfq.invitedVendors.find((v) => v.vendorExtId === vendorId);
  if (!invitation) {
    return next(ApiError.notFound('RFQ not found'));
  }

  if (rfq.status !== 'Bidding Open') {
    return next(ApiError.badRequest('Bidding is closed for this RFQ'));
  }

  if (new Date() > new Date(rfq.deadlineDate)) {
    return next(ApiError.badRequest('RFQ submission deadline has passed'));
  }

  // Fetch Vendor's DB row & rating
  const vendor = await prisma.vendor.findFirst({ where: { OR: [{ vendorId }, { clerkId: vendorId }] } });

  // Verify all line items are priced
  for (const item of rfq.items) {
    if (unitPrices[item.line] === undefined) {
      return next(ApiError.badRequest(`Missing unit price for line ${item.line}`));
    }
  }

  const rating = invitation.rating || 80;
  const taxCode = gstToTaxCode(gstRate);

  const bidFields = {
    vendorId,
    vendorPk: vendor ? vendor.pk : null,
    vendorName: vendor ? vendor.companyName : 'Test Vendor',
    gstRate: String(gstRate),
    taxCode,
    freight: Number(freight || 0),
    deliveryLeadTimeDays: Number(deliveryLeadTimeDays || 7),
    vendorRating: Number(rating),
    technicalScore: 80, // standard default
    validityDate: validityDate ? new Date(validityDate) : null,
    remarks,
    submittedAt: new Date(),
  };

  // Check if vendor already bid, replace or insert
  let bid = await prisma.rfqBid.findFirst({ where: { rfqPk: rfq.pk, vendorId } });
  if (bid) {
    bid = await prisma.rfqBid.update({ where: { pk: bid.pk }, data: bidFields });
    await prisma.rfqBidUnitPrice.deleteMany({ where: { bidPk: bid.pk } });
    await prisma.rfqBidDocument.deleteMany({ where: { bidPk: bid.pk } });
  } else {
    bid = await prisma.rfqBid.create({ data: { rfqPk: rfq.pk, ...bidFields } });
  }

  await prisma.rfqBidUnitPrice.createMany({
    data: Object.entries(unitPrices).map(([line, price]) => ({
      bidPk: bid.pk, lineNumber: Number(line), price: Number(price),
    })),
  });
  if (uploadedDocs?.length) {
    await prisma.rfqBidDocument.createMany({
      data: uploadedDocs.map((doc) => ({
        bidPk: bid.pk, documentId: doc.documentId, originalName: doc.originalName, url: doc.url,
      })),
    });
  }

  // If first bid, set status to Submitted
  if (rfq.status === 'Bidding Open') {
    await prisma.rFQ.update({ where: { pk: rfq.pk }, data: { status: 'Submitted' } });
  }

  const bidsCount = await prisma.rfqBid.count({ where: { rfqPk: rfq.pk } });
  res.json({ message: 'Bid submitted successfully', bidsCount });
});

// @desc    Push an updated net price for a SAP-native quotation document
//          (ME47, ZQUOT_NETPR/QUOT_UPDPR) — a real SAP write, distinct from
//          submitBid above. `sapRfqNumber` is the SAP document (ebeln, e.g.
//          "6000000062") the vendor is responding to, taken from what
//          ME48/ME43 already show them in the SAP Documents tab; `items`
//          reuses this portal RFQ's own line numbers so the vendor is only
//          ever pricing lines they can already see in RFQ Monitor & History.
// @route   POST /api/rfqs/:id/sap-quote-price
// @access  Public
const updateSapQuotationPrice = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const { sapRfqNumber, items } = req.body;

  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id }, include: { items: true } });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  const validLines = new Set(rfq.items.map((item) => String(item.line)));
  const unknownLine = items.find((item) => !validLines.has(String(item.line)));
  if (unknownLine) {
    return next(ApiError.badRequest(`Line ${unknownLine.line} is not part of RFQ ${rfq.id}`));
  }

  const vendor = await prisma.vendor.findFirst({ where: { OR: [{ vendorId }, { clerkId: vendorId }] } });
  if (!vendor) {
    return next(ApiError.notFound('Vendor not found'));
  }

  const sap = await getSapAdapterForClient(req.clientId);
  const result = await sap.quotationUpdatePrice({
    vendor,
    sapRfqNumber,
    items: items.map(({ line, netPrice }) => ({ item: line, netPrice })),
  });

  const io = req.app.get('io');
  if (result.transaction) {
    emitToVendor(io, req.clientId, vendorId, EVENTS.LOG_NEW, { type: result.transaction.type, name: result.transaction.code });
  }

  res.json({ message: result.message || 'Quotation price updated in SAP', sapRfqNumber: result.sapRfqNumber });
});

// @desc    Get Evaluation Matrix (ME48)
// @route   GET /api/rfqs/:id/evaluate
// @access  Public
const getEvaluationMatrix = asyncHandler(async (req, res, next) => {
  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id }, include: RFQ_INCLUDE });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  if (!rfq.bids || rfq.bids.length === 0) {
    return res.json({ rfqId: rfq.id, evaluation: [] });
  }

  // Calculate total costs and find minimums
  const vendorsAnalysis = rfq.bids.map((bid) => {
    const prices = new Map(bid.unitPrices.map((u) => [String(u.lineNumber), u.price]));
    let totalCost = 0;
    rfq.items.forEach((item) => {
      const price = prices.get(String(item.line)) || 0;
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

  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id }, include: RFQ_INCLUDE });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }

  if (rfq.status === 'Awarded') {
    return next(ApiError.badRequest('This RFQ has already been awarded'));
  }

  const winningBid = rfq.bids.find((b) => b.vendorId === vendorId);
  if (!winningBid) {
    return next(ApiError.notFound('Bid not found for the specified vendor'));
  }
  // u.price is a Decimal-typed column — converted to a plain number here
  // rather than left to `netValue: unitPrice * item.quantity` below's implicit
  // coercion (see utils/money.js for why that split behavior isn't something
  // to lean on, even where `*` happens to get it right).
  const winningPrices = new Map(winningBid.unitPrices.map((u) => [String(u.lineNumber), toNumber(u.price)]));

  // Get Vendor DB row
  const vendor = await prisma.vendor.findFirst({ where: { OR: [{ vendorId }, { clerkId: vendorId }] } });

  const year = new Date().getFullYear();

  const clientId = getTenantId();
  // Map RFQ items and bid prices to PO items — a nested write, so clientId is
  // stamped explicitly on each item (see createRFQ's note above).
  const poItemsData = rfq.items.map((item) => {
    const unitPrice = winningPrices.get(String(item.line)) || 0;
    return {
      clientId,
      line: item.line,
      materialCode: item.materialCode,
      description: item.description,
      quantity: item.quantity,
      grnQuantity: 0,
      unitPrice,
      netValue: unitPrice * item.quantity,
      uom: item.uom || 'EA',
    };
  });

  // Create Purchase Order.
  //
  // sapPoNumber is deliberately null. This used to invent one — '4500' plus six
  // random digits, indistinguishable from a real SAP order number to anyone
  // reading the screen. The portal does not create purchase orders in SAP, so
  // the order carries no SAP number until it is matched against SAP's own
  // ledger (vendorPoGrnDisplay). The goods-receipt and payment polls both wait
  // on that number rather than acting on a fabricated one.
  //
  // The RFQ's flip to Awarded and the PO create are one transaction, and the
  // flip is a conditional update (`status: { not: 'Awarded' }`) run FIRST —
  // this is what actually closes the race the early status check above only
  // optimises for. Two concurrent awards of the same RFQ both pass that
  // check and both reach here; without the conditional update, both would go
  // on to create a real PO from one RFQ. Postgres serialises the two UPDATEs
  // against the same row: the second one blocks until the first commits, then
  // re-evaluates its WHERE against the now-committed row and matches zero
  // rows. `count === 0` is this transaction's signal that it lost the race,
  // and throwing inside a `$transaction` callback rolls back everything in
  // it, so the loser leaves nothing behind.
  //
  // Flipping the RFQ before generating the PO id (rather than after, or
  // before the transaction at all) matters for a reason distinct from the
  // race above: nextSequentialId scans for "not yet used", and two
  // transactions racing to award the *same* RFQ would otherwise both compute
  // the same next PO number before either commits — surfacing as a confusing
  // duplicate-id 409 for the loser instead of the "already awarded" 400 that
  // actually explains what happened. Only the transaction that wins the flip
  // above ever reaches the id generation below, so that collision can no
  // longer happen for this RFQ. (A *different* RFQ awarded in the same
  // instant can still momentarily compute the same next number — the
  // pre-existing, deliberately-kept race nextSequentialId's own comment
  // documents; unrelated to what this closes.)
  const po = await prisma.$transaction(async (tx) => {
    const flipped = await tx.rFQ.updateMany({
      where: { pk: rfq.pk, status: { not: 'Awarded' } },
      data: {
        status: 'Awarded',
        awardedVendorId: vendorId,
        awardedVendorName: vendor ? vendor.companyName : winningBid.vendorName,
        awardedAt: new Date(),
      },
    });

    if (flipped.count === 0) {
      throw ApiError.badRequest('This RFQ has already been awarded');
    }

    const poId = await nextSequentialId('purchaseOrder', `PO-${year}-`, 4, tx);
    const created = await tx.purchaseOrder.create({
      data: {
        id: poId,
        sapPoNumber: null,
        // A PO always needs matching against SAP's own ledger, unlike an RFQ
        // (portal-internal by design — see the note on RFQ.sapSyncState in
        // schema.prisma) — Phase 3 of docs/04-sap-runtime-engineering-plan.md.
        // getSapPoStatus (po.controller.js) flips this to `synced` the moment
        // vendorPoGrnDisplay correlates it.
        sapSyncState: 'pending',
        vendorId,
        vendorPk: vendor ? vendor.pk : winningBid.vendorPk,
        buyerName: 'SAP System Procurement',
        plant: rfq.items[0]?.plant || '1000',
        paymentTerms: rfq.paymentTerms || 'NET 30 Days',
        currency: rfq.currency || 'INR',
        deliveryAddress: rfq.deliveryLocation || 'Plant 1000 Address',
        status: 'Open',
        fromRfqId: rfq.id,
        items: { create: poItemsData },
      },
      include: { items: true },
    });

    await tx.rFQ.update({ where: { pk: rfq.pk }, data: { convertedPoId: created.id } });

    return created;
  });

  res.json({ message: 'RFQ awarded and Purchase Order created successfully', po: formatPo(po) });
});

// @desc    Download the awarded PO as a file (Phase 5.2 of
//          docs/04-sap-runtime-engineering-plan.md — the export bridge). A
//          file the buyer's own MM team imports on their own schedule, not a
//          live SAP write: sourcing has no confirmed write path (see
//          sap/contract.js's notes) so this is the deliberate alternative to
//          the screen-scrape the original spec asked for.
// @route   GET /api/rfqs/:id/export?format=csv|xlsx|json|idoc
// @access  Public
const exportAwardedPo = asyncHandler(async (req, res, next) => {
  const format = String(req.query.format || 'csv').toLowerCase();
  const exporter = EXPORT_FORMATS[format];
  if (!exporter) {
    return next(ApiError.badRequest(`Unsupported export format '${format}'. Use one of: ${Object.keys(EXPORT_FORMATS).join(', ')}`));
  }

  const rfq = await prisma.rFQ.findFirst({ where: { id: req.params.id } });
  if (!rfq) {
    return next(ApiError.notFound('RFQ not found'));
  }
  if (!rfq.convertedPoId) {
    return next(ApiError.badRequest('This RFQ has not been awarded yet'));
  }

  const po = await prisma.purchaseOrder.findFirst({
    where: { id: rfq.convertedPoId },
    include: { items: { orderBy: { line: 'asc' } }, vendor: true },
  });
  if (!po) {
    return next(ApiError.notFound('Purchase order not found for this RFQ'));
  }

  const payload = buildExportPayload({ rfq, po });
  const body = exporter.build(payload);

  res.setHeader('Content-Type', exporter.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${po.id}.${exporter.extension}"`);
  res.send(body);
});

module.exports = {
  getRFQs,
  getRFQById,
  createRFQ,
  cancelRFQ,
  reissueRFQ,
  submitBid,
  getEvaluationMatrix,
  awardBid,
  getSapRfqStatus,
  getSapQuotationStatus,
  updateSapQuotationPrice,
  exportAwardedPo
};
