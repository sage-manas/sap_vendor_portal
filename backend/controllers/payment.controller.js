const Payment = require('../models/Payment');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withVendorScope, requireVendorScope } = require('../utils/requestScope');

// @desc    Get Payments
// @route   GET /api/payments
// @access  Public
const getPayments = asyncHandler(async (req, res, next) => {
  const { page = 1, limit = 10 } = req.query;

  const query = withVendorScope(req);

  const skip = (page - 1) * limit;
  const payments = await Payment.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  const total = await Payment.countDocuments(query);

  res.json({
    payments,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / limit)
    }
  });
});

// @desc    Get Payment by ID
// @route   GET /api/payments/:id
// @access  Public
const getPaymentById = asyncHandler(async (req, res, next) => {
  const payment = await Payment.findOne({ id: req.params.id });
  if (!payment) {
    return next(ApiError.notFound('Payment not found'));
  }
  res.json(payment);
});

// @desc    Create Payment
// @route   POST /api/payments
// @access  Public
const createPayment = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  const paymentData = { ...req.body, vendorId };

  if (!paymentData.id) {
    paymentData.id = 'PMT-' + Math.floor(100000 + Math.random() * 900000);
  }

  const payment = await Payment.create(paymentData);
  res.status(201).json(payment);
});

// @desc    Update Payment status
// @route   PUT /api/payments/:id/status
// @access  Public
const updatePaymentStatus = asyncHandler(async (req, res, next) => {
  const { status } = req.body;
  if (!status) {
    return next(ApiError.badRequest('Status is required'));
  }

  const payment = await Payment.findOne({ id: req.params.id });
  if (!payment) {
    return next(ApiError.notFound('Payment not found'));
  }

  payment.status = status;
  await payment.save();

  res.json({ message: 'Payment status updated successfully', payment });
});

module.exports = {
  getPayments,
  getPaymentById,
  createPayment,
  updatePaymentStatus
};
