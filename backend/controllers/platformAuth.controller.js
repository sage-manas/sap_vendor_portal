const PlatformUser = require('../models/PlatformUser');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { signToken } = require('../utils/authToken');
const { sendMail } = require('../utils/mailer');
const { hashResetToken, RESET_TOKEN_TTL_MS } = require('../models/plugins/credentialsPlugin');
const { frontendUrl } = require('../config/emailTemplates');

// The platform plane's own login surface. Separate endpoint, separate
// collection, separate token audience — an operator's credentials are never
// accepted at /api/auth/login and a tenant's are never accepted here
// (ADR-0008). Phase 3 adds mandatory MFA on top of this flow.

const formatOperator = (operator) => ({
  id: operator._id,
  email: operator.email,
  name: operator.name,
  role: operator.role,
  status: operator.status,
  mfaEnabled: operator.mfaEnabled,
  lastLoginAt: operator.lastLoginAt,
});

// @desc    Operator login
// @route   POST /api/platform/auth/login
// @access  Public
const login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  const operator = await PlatformUser
    .findOne({ email: String(email || '').toLowerCase() })
    .select('+password');

  if (!operator || !(await operator.comparePassword(password))) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }
  if (!operator.canAuthenticate()) {
    return next(ApiError.forbidden('This account is not active'));
  }

  operator.lastLoginAt = new Date();
  await operator.save({ validateBeforeSave: false });

  res.json({
    success: true,
    token: signToken(operator),
    mustChangePassword: Boolean(operator.mustChangePassword),
    // Phase 3 refuses the console until this is true.
    mfaEnrolled: Boolean(operator.mfaEnabled),
    operator: formatOperator(operator),
  });
});

// @desc    The signed-in operator
// @route   GET /api/platform/auth/me
// @access  Private (platform)
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, auth: req.auth, operator: formatOperator(req.platformUser) });
});

// @desc    Change your own operator password
// @route   POST /api/platform/auth/change-password
// @access  Private (platform)
const changePassword = asyncHandler(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;

  const operator = await PlatformUser.findById(req.auth.id).select('+password');
  if (!operator || !(await operator.comparePassword(currentPassword))) {
    return next(ApiError.unauthorized('Current password is incorrect'));
  }

  operator.password = newPassword;
  operator.mustChangePassword = false;
  await operator.save();

  res.json({ success: true, message: 'Password updated.' });
});

const GENERIC_FORGOT_MESSAGE = 'If an operator account exists for this email, a password reset link has been sent.';

// @desc    Request an operator password reset
// @route   POST /api/platform/auth/forgot-password
// @access  Public
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const operator = await PlatformUser.findOne({ email: String(email || '').toLowerCase() });

  if (!operator || !operator.canAuthenticate()) {
    return res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
  }

  const rawToken = operator.issueResetToken();
  await operator.save({ validateBeforeSave: false });

  await sendMail({
    to: operator.email,
    template: 'passwordReset',
    data: {
      name: operator.name,
      resetUrl: `${frontendUrl()}/platform/reset-password?token=${rawToken}`,
      expiresInMinutes: RESET_TOKEN_TTL_MS / 60000,
    },
  });
  logger.info(`Platform password reset email dispatched for operator ${operator._id}`);

  res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
});

// @desc    Complete an operator password reset
// @route   POST /api/platform/auth/reset-password
// @access  Public
const resetPassword = asyncHandler(async (req, res, next) => {
  const { token, password } = req.body;

  const operator = await PlatformUser.findOne({
    resetPasswordToken: hashResetToken(String(token || '')),
    resetPasswordExpires: { $gt: new Date() },
  });

  if (!operator) {
    return next(ApiError.badRequest('Password reset token is invalid or has expired'));
  }

  operator.consumeResetToken(password);
  await operator.save({ validateBeforeSave: false });

  res.json({ success: true, message: 'Password has been reset. You can now sign in.' });
});

module.exports = { login, getMe, changePassword, forgotPassword, resetPassword, formatOperator };
