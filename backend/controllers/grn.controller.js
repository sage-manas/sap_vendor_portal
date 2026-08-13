const GRN = require('../models/GRN');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withVendorScope } = require('../utils/requestScope');

// @desc    Get GRNs
// @route   GET /api/grns
// @access  Public
const getGRNs = asyncHandler(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;

  const query = withVendorScope(req);

  const skip = (page - 1) * limit;
  const grns = await GRN.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await GRN.countDocuments(query);

  res.json({
    grns,
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
  const grn = await GRN.findOne({ id: req.params.id });
  if (!grn) {
    return next(ApiError.notFound('GRN not found'));
  }
  res.json(grn);
});

module.exports = {
  getGRNs,
  getGRNById
};
