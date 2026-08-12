const crypto = require('crypto');
const Vendor = require('../models/Vendor');
const Client = require('../models/Client');
const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { resolveClientForRequest } = require('../utils/resolveClient');
const { planeOf } = require('../config/roles');

// Assigns a vendorId server-side so nothing client-supplied has to be trusted
// as the account's real identity. Retries on the (extremely unlikely) chance
// of a collision with an existing document.
// vendorId is a login identity, so uniqueness is checked across all tenants.
const generateVendorId = async () => {
  let vendorId;
  let exists = true;
  while (exists) {
    vendorId = `VND-${Math.floor(10000 + Math.random() * 90000)}`;
    exists = await withoutTenantScope(() => Vendor.exists({ vendorId }));
  }
  return vendorId;
};

// Helper to format flat vendor db document to backwards-compatible format with nested objects
const formatVendorResponse = (vendor) => {
  if (!vendor) return null;
  const obj = vendor.toObject ? vendor.toObject({ virtuals: true }) : { ...vendor };

  // Never expose the password hash (select:false does not strip it on create/+password queries)
  delete obj.password;

  obj.bankDetails = {
    bankName: obj.bankName || '',
    accountNumber: obj.accountNumber || '',
    ifscCode: obj.ifscCode || '',
    accountName: obj.accountName || '',
    accountHolderName: obj.accountName || '',
    branch: obj.bankBranch || '',
    accountType: 'Current'
  };
  
  return obj;
};

// Generate JWT token helper. clientId + roleScope are what the API enforces
// on every subsequent request — never trust anything else for tenancy.
const generateToken = (vendor) => {
  return jwt.sign(
    {
      id: vendor._id,
      vendorId: vendor.vendorId,
      email: vendor.email,
      clientId: vendor.clientId,
      roleScope: planeOf(vendor.role),
    },
    process.env.JWT_SECRET || 'secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
};

// @desc    Register a new vendor
// @route   POST /api/auth/register
// @access  Public
const register = asyncHandler(async (req, res, next) => {
  const { password, companyName, gstin, pan, email, phone, address, city, state, postalCode, bankName, accountNumber, ifscCode, accountName, bankBranch } = req.body;
  let { vendorId } = req.body;

  // Which workspace is this supplier registering into? (Subdomain in Phase 6;
  // header/DEFAULT_CLIENT_SLUG/legacy until then.)
  const client = await resolveClientForRequest(req);
  if (!client) {
    return next(ApiError.badRequest('Unknown workspace'));
  }
  if (!client.isOperational()) {
    return next(ApiError.forbidden('This workspace is not accepting registrations'));
  }

  // Login identities are global, so this collision check spans all tenants.
  const existingVendor = await withoutTenantScope(() => Vendor.findOne({
    $or: [{ email }, { gstin }, ...(vendorId ? [{ vendorId }] : [])]
  }));

  if (existingVendor) {
    return next(ApiError.conflict('Vendor with this ID, email, or GSTIN already exists'));
  }

  if (!vendorId) {
    vendorId = await generateVendorId();
  }

  // Freshly self-registered vendors start as a Draft until they complete
  // and submit the full onboarding form.
  const defaultStatus = vendorId.startsWith('mock_vendor_') ? 'Pending' : 'Draft';

  // Bootstrap: emails listed in ADMIN_BOOTSTRAP_EMAILS (comma-separated) get
  // the admin role on first registration — there is no other signup path
  // that produces an admin account, so this env var is the intended way to
  // provision the first admin(s) for a deployment.
  const bootstrapEmails = (process.env.ADMIN_BOOTSTRAP_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  const role = bootstrapEmails.includes((email || '').toLowerCase()) ? 'admin' : 'vendor';

  const vendor = await runWithTenant(client.clientId, () => Vendor.create({
    vendorId,
    password,
    companyName,
    gstin,
    pan,
    email,
    phone,
    address,
    city,
    state,
    postalCode,
    bankName,
    accountNumber,
    ifscCode,
    accountName,
    bankBranch,
    status: defaultStatus,
    role
  }));

  const token = generateToken(vendor);
  const formattedVendor = formatVendorResponse(vendor);

  res.status(201).json({
    success: true,
    token,
    vendor: formattedVendor
  });
});

// @desc    Login vendor
// @route   POST /api/auth/login
// @access  Public
const login = asyncHandler(async (req, res, next) => {
  const { vendorIdOrEmail, password } = req.body;

  // Search vendor by email or vendorId. Login precedes tenancy — the account
  // itself carries the clientId that every later request is bound to.
  const vendor = await withoutTenantScope(() => Vendor.findOne({
    $or: [{ email: vendorIdOrEmail.toLowerCase() }, { vendorId: vendorIdOrEmail }]
  }).select('+password'));

  if (!vendor) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  const isMatch = await vendor.comparePassword(password);
  if (!isMatch) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  const client = await withoutTenantScope(() => Client.findOne({ clientId: vendor.clientId }));
  if (!client || !client.isOperational()) {
    return next(ApiError.forbidden('This workspace is not active'));
  }

  const token = generateToken(vendor);
  const formattedVendor = formatVendorResponse(vendor);

  res.json({
    success: true,
    token,
    vendor: formattedVendor
  });
});

// @desc    Get currently logged in vendor profile
// @route   GET /api/auth/me
// @access  Private
const getMe = asyncHandler(async (req, res, next) => {
  res.json({
    success: true,
    vendor: formatVendorResponse(req.vendor)
  });
});

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const GENERIC_FORGOT_MESSAGE = 'If an account exists for this email, a password reset link has been sent.';

// @desc    Issue a time-limited password reset token
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = asyncHandler(async (req, res, next) => {
  const { email } = req.body;
  // Reset flows run pre-login, so they address the global identity space.
  const vendor = await withoutTenantScope(() => Vendor.findOne({ email: email.toLowerCase() }));

  // Same response whether or not the email exists, so this endpoint can't be
  // used to enumerate registered vendors.
  if (!vendor) {
    return res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  vendor.resetPasswordToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  vendor.resetPasswordExpires = Date.now() + RESET_TOKEN_TTL_MS;
  await withoutTenantScope(() => vendor.save());

  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;
  // No email service is configured for this portal — log the link instead so
  // it can be retrieved by an operator until one is wired up.
  logger.info(`Password reset requested for ${vendor.email}: ${resetUrl}`);

  res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
});

// @desc    Reset a vendor's password using a token issued by forgotPassword
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = asyncHandler(async (req, res, next) => {
  const { token, password } = req.body;
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const vendor = await withoutTenantScope(() => Vendor.findOne({
    resetPasswordToken: hashedToken,
    resetPasswordExpires: { $gt: Date.now() }
  }));

  if (!vendor) {
    return next(ApiError.badRequest('Password reset token is invalid or has expired'));
  }

  vendor.password = password;
  vendor.resetPasswordToken = undefined;
  vendor.resetPasswordExpires = undefined;
  await withoutTenantScope(() => vendor.save());

  res.json({ success: true, message: 'Password has been reset. You can now sign in.' });
});

module.exports = {
  register,
  login,
  getMe,
  forgotPassword,
  resetPassword
};
