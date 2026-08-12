const PlatformUser = require('../models/PlatformUser');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { signToken } = require('../utils/authToken');
const { sendMail } = require('../utils/mailer');
const { hashResetToken, RESET_TOKEN_TTL_MS } = require('../models/plugins/credentialsPlugin');
const { frontendUrl } = require('../config/emailTemplates');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { encrypt, decrypt } = require('../utils/secretBox');
const totp = require('../utils/totp');

// The platform plane's own login surface. Separate endpoint, separate
// collection, separate token audience — an operator's credentials are never
// accepted at /api/auth/login and a tenant's are never accepted here
// (ADR-0008).
//
// Sign-in is two steps, always (ADR-0016). The password check mints a token
// carrying `mfa: false`, which opens only this file's endpoints; the console
// itself sits behind `requireMfa` and needs a token minted by `verifyMfa`.

const formatOperator = (operator) => ({
  id: operator._id,
  email: operator.email,
  name: operator.name,
  role: operator.role,
  status: operator.status,
  mfaEnabled: Boolean(operator.mfaEnabled),
  mfaEnrolledAt: operator.mfaEnrolledAt,
  lastLoginAt: operator.lastLoginAt,
});

// An operator identified only by a half-authenticated token: `protectPlatform`
// has resolved them, but they may not have cleared the second factor yet. The
// MFA secret is stored encrypted (utils/secretBox) and is only ever decrypted
// here, in memory, to check a six-digit code.
const withMfaSecret = (id) => PlatformUser.findById(id).select('+mfaSecret');

// @desc    Operator login
// @route   POST /api/platform/auth/login
// @access  Public
const login = asyncHandler(async (req, res, next) => {
  const { email, password } = req.body;

  const operator = await PlatformUser
    .findOne({ email: String(email || '').toLowerCase() })
    .select('+password');

  if (!operator || !(await operator.comparePassword(password))) {
    await recordAudit({
      action: AUDIT_ACTIONS.OPERATOR_LOGIN_FAILED,
      clientId: null,
      actor: { actorId: operator ? String(operator._id) : 'unknown', actorRole: operator?.role || 'unknown', actorEmail: String(email || '').toLowerCase(), plane: 'platform' },
      meta: { ip: req.ip },
    });
    return next(ApiError.unauthorized('Invalid credentials'));
  }
  if (!operator.canAuthenticate()) {
    return next(ApiError.forbidden('This account is not active'));
  }

  operator.lastLoginAt = new Date();
  await operator.save({ validateBeforeSave: false });

  await recordAudit({
    action: AUDIT_ACTIONS.OPERATOR_LOGIN,
    clientId: null,
    actor: { actorId: String(operator._id), actorRole: operator.role, actorEmail: operator.email, plane: 'platform' },
    meta: { step: 'password', ip: req.ip },
  });

  res.json({
    success: true,
    // Half a session: good for changing a password and for enrolling or
    // clearing MFA, and for nothing else.
    token: signToken(operator, { mfa: false }),
    mustChangePassword: Boolean(operator.mustChangePassword),
    mfaEnrolled: Boolean(operator.mfaEnabled),
    // What the client must do next, named rather than inferred.
    next: operator.mustChangePassword ? 'change_password'
      : operator.mfaEnabled ? 'verify_mfa' : 'enrol_mfa',
    operator: formatOperator(operator),
  });
});

// @desc    Begin MFA enrolment: returns a fresh secret and its otpauth:// URI
// @route   POST /api/platform/auth/mfa/enrol
// @access  Private (platform, pre-MFA)
//
// The secret is returned exactly once, here, because the operator has to get it
// into an authenticator app. It is stored encrypted and never returned again,
// never logged and never audited.
const enrolMfa = asyncHandler(async (req, res, next) => {
  const operator = await withMfaSecret(req.auth.id);

  if (operator.mfaEnabled) {
    // Re-enrolling would silently invalidate the working authenticator of
    // whoever holds this session. Clearing it is an operator:manage action.
    return next(ApiError.conflict('This account already has an authenticator enrolled. Ask a super admin to reset it.'));
  }

  const secret = totp.generateSecret();
  operator.mfaSecret = encrypt(secret);
  operator.mfaEnabled = false;
  await operator.save({ validateBeforeSave: false });

  res.json({
    success: true,
    secret,
    otpauthUrl: totp.otpauthUrl({ secret, account: operator.email }),
    message: 'Scan this in your authenticator, then confirm the six-digit code to finish enrolment.',
  });
});

// @desc    Confirm a six-digit code — completes enrolment, or clears the second
//          factor on an existing session
// @route   POST /api/platform/auth/mfa/verify
// @access  Private (platform, pre-MFA)
const verifyMfa = asyncHandler(async (req, res, next) => {
  const operator = await withMfaSecret(req.auth.id);
  const secret = operator.mfaSecret ? decrypt(operator.mfaSecret) : null;

  if (!secret) {
    return next(ApiError.badRequest('No authenticator is enrolled for this account', { reason: 'mfa_enrolment_required' }));
  }
  if (!totp.verifyToken(secret, req.body.code)) {
    return next(ApiError.unauthorized('That code is not valid'));
  }

  const justEnrolled = !operator.mfaEnabled;
  if (justEnrolled) {
    operator.mfaEnabled = true;
    operator.mfaEnrolledAt = new Date();
    await operator.save({ validateBeforeSave: false });

    await recordAudit({
      req,
      action: AUDIT_ACTIONS.OPERATOR_MFA_ENROLLED,
      clientId: null,
      target: { type: 'PlatformUser', id: String(operator._id), label: operator.email },
    });
  }

  res.json({
    success: true,
    // The full session. This is the only token `requireMfa` accepts.
    token: signToken(operator, { mfa: true }),
    enrolled: justEnrolled,
    operator: formatOperator(operator),
  });
});

// @desc    The signed-in operator
// @route   GET /api/platform/auth/me
// @access  Private (platform)
const getMe = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    auth: req.auth,
    // What this particular session may do, so the console can route to the
    // enrolment or code screen without guessing from a 403.
    mfa: req.mfa,
    mustChangePassword: Boolean(req.platformUser.mustChangePassword),
    operator: formatOperator(req.platformUser),
  });
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

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.OPERATOR_PASSWORD_CHANGED,
    clientId: null,
    target: { type: 'PlatformUser', id: String(operator._id), label: operator.email },
  });

  res.json({
    success: true,
    message: 'Password updated.',
    // The session keeps whatever second-factor standing it already had.
    token: signToken(operator, { mfa: req.mfa?.verified === true }),
    next: operator.mfaEnabled ? (req.mfa?.verified ? 'console' : 'verify_mfa') : 'enrol_mfa',
  });
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

module.exports = {
  login,
  getMe,
  changePassword,
  forgotPassword,
  resetPassword,
  enrolMfa,
  verifyMfa,
  formatOperator,
};
