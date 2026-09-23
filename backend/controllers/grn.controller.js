const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withVendorScope, scopedWhere } = require('../utils/requestScope');
const { toNumber } = require('../utils/quantity');

// receivedQuantity/acceptedQuantity/rejectedQuantity are Decimal-typed
// columns (issue #65) — converted here, since this is the one place every
// GRN reaches the API through. Left unconverted, `sum + item.acceptedQuantity`
// below would silently concatenate strings instead of adding (see
// utils/money.js's header comment), and the raw items array would reach
// res.json() with each quantity serialized as a string, not a number.
const formatGrnItem = (item) => ({
  ...item,
  receivedQuantity: toNumber(item.receivedQuantity),
  acceptedQuantity: toNumber(item.acceptedQuantity),
  rejectedQuantity: toNumber(item.rejectedQuantity),
});

// `totalAccepted`/`rejectionRate` were Mongoose virtuals (models/GRN.js),
// computed from `items` and serialized automatically via `toJSON`. Replicated
// here as the same compute-after-fetch, same formula — see the migration
// plan's decision to keep these as an app-layer read rather than a stored or
// generated column.
const withVirtuals = (grn) => {
  const items = (grn.items || []).map(formatGrnItem);
  const totalAccepted = items.reduce((sum, item) => sum + item.acceptedQuantity, 0);
  const totalReceived = items.reduce((sum, item) => sum + item.receivedQuantity, 0);
  const totalRejected = items.reduce((sum, item) => sum + item.rejectedQuantity, 0);
  const rejectionRate = totalReceived === 0 ? 0 : (totalRejected / totalReceived) * 100;
  return { ...grn, items, totalAccepted, rejectionRate };
};

// @desc    Get GRNs
// @route   GET /api/grns
// @access  Public
const getGRNs = asyncHandler(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;

  const where = withVendorScope(req);

  const skip = (page - 1) * limit;
  const [grns, total] = await Promise.all([
    prisma.gRN.findMany({ where, include: { items: true }, orderBy: { createdAt: 'desc' }, skip, take: Number(limit) }),
    prisma.gRN.count({ where }),
  ]);

  res.json({
    grns: grns.map(withVirtuals),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Get GRN by ID
// @route   GET /api/grns/:id
// @access  Public
const getGRNById = asyncHandler(async (req, res, next) => {
  const grn = await prisma.gRN.findFirst({ where: scopedWhere(req, { id: req.params.id }), include: { items: true } });
  if (!grn) {
    return next(ApiError.notFound('Delivery receipt not found'));
  }
  res.json(withVirtuals(grn));
});

module.exports = {
  getGRNs,
  getGRNById
};
