const { prisma } = require('../db/prisma');
const { hashPassword, comparePassword, issueResetToken, consumeResetToken, hashResetToken, RESET_TOKEN_TTL_MS } = require('../db/credentials');
const { canAuthenticate } = require('../db/accountHelpers');
const { isClientOperational } = require('../db/clientHelpers');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { resolveClientForRequest, resolveRealmForRequest } = require('../utils/resolveClient');
const { ROLES } = require('../config/roles');
const { signToken } = require('../utils/authToken');
const { sendMail } = require('../utils/mailer');
const { frontendUrl } = require('../config/emailTemplates');
const { generateVendorId } = require('../utils/vendorIdentity');
const { settingValue } = require('../config/tenantSettings');
const { hasSupplierInvitation } = require('./invitation.controller');
const { assertCanCreate } = require('../utils/usage');

// Helper to format a Vendor row to the backwards-compatible response shape
// with nested objects. Rows come back with password/reset fields present
// whenever a call site explicitly un-omitted them (login, changePassword) —
// they are stripped here defensively regardless.
const formatVendorResponse = (vendor) => {
  if (!vendor) return null;
  const obj = { ...vendor };

  delete obj.password;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;

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

// Tenant staff have no supplier record, so they get their own shape. The
// `role`/`plane` fields are what the UI filters its nav on (Phase 5).
const formatUserResponse = (user) => {
  if (!user) return null;
  const obj = { ...user };
  delete obj.password;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  return obj;
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
  if (!isClientOperational(client)) {
    return next(ApiError.forbidden('This workspace is not accepting registrations'));
  }

  // A workspace can close self-service registration and admit suppliers by
  // invitation only (config/tenantSettings.js). An invited supplier is not
  // self-service, so their invitation is what reopens the door for them.
  if (!settingValue(client, 'features.supplierSelfRegistration')
    && !(await hasSupplierInvitation(client.clientId, email))) {
    return next(ApiError.forbidden('This workspace admits suppliers by invitation only'));
  }

  // Login identities are global and shared across the identity collections, so
  // this collision check spans all tenants and both account kinds.
  const existingVendor = await withoutTenantScope(() => prisma.vendor.findFirst({
    where: { OR: [{ email }, { gstin }, ...(vendorId ? [{ vendorId }] : [])] },
  }));
  const existingUser = email
    ? await withoutTenantScope(() => prisma.user.findFirst({ where: { email: email.toLowerCase() } }))
    : null;

  if (existingVendor || existingUser) {
    return next(ApiError.conflict('Vendor with this ID, email, or GSTIN already exists'));
  }

  await assertCanCreate(client, 'vendors');

  if (!vendorId) {
    vendorId = await generateVendorId();
  }

  // Freshly self-registered vendors start as a Draft until they complete
  // and submit the full onboarding form.
  const defaultStatus = vendorId.startsWith('mock_vendor_') ? 'Pending' : 'Draft';

  const { password: hashedPassword, passwordChangedAt } = await hashPassword(password);

  // Self-registration only ever produces a supplier. Staff accounts come from
  // an invitation or from tenant provisioning — ADMIN_BOOTSTRAP_EMAILS, which
  // used to mint an admin from a public endpoint, is gone (ADR-0009).
  const vendor = await runWithTenant(client.clientId, () => prisma.vendor.create({
    data: {
      vendorId,
      password: hashedPassword,
      passwordChangedAt,
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
      role: ROLES.VENDOR
    },
  }));

  res.status(201).json({
    success: true,
    token: signToken(vendor),
    vendor: formatVendorResponse(vendor)
  });
});

// The public face of a tenant: who a visitor is about to sign in to, and what
// their sign-in screen is allowed to offer. Values come through the settings
// registry, so "never set" is answered in one place.
const describeWorkspace = (client) => ({
  clientId: client.clientId,
  companyName: client.companyName,
  slug: client.slug,
  branding: {
    logo: settingValue(client, 'branding.logo'),
    primaryColor: settingValue(client, 'branding.primaryColor'),
  },
  features: {
    supplierChat: settingValue(client, 'features.supplierChat'),
    supplierSelfRegistration: settingValue(client, 'features.supplierSelfRegistration'),
  },
});

// @desc    The workspace this hostname belongs to, for signed-out screens
// @route   GET /api/auth/workspace
// @access  Public
const getWorkspace = asyncHandler(async (req, res, next) => {
  const { client } = await resolveRealmForRequest(req);

  // An unknown slug and a suspended tenant answer alike: a visitor at the wrong
  // address learns that there is nothing here, not which of the two it is.
  if (!client || !isClientOperational(client)) {
    return next(ApiError.notFound('Unknown workspace'));
  }

  res.json({ success: true, workspace: describeWorkspace(client) });
});

// @desc    Login (supplier or tenant staff)
// @route   POST /api/auth/login
// @access  Public
const login = asyncHandler(async (req, res, next) => {
  const { vendorIdOrEmail, password } = req.body;
  const identifier = String(vendorIdOrEmail || '').trim();

  // Login precedes tenancy — the account itself carries the clientId that every
  // later request is bound to. Staff sign in with an email; suppliers with
  // either their email or their vendorId.
  const user = await withoutTenantScope(() =>
    prisma.user.findFirst({ where: { email: identifier.toLowerCase() }, omit: { password: false } }));

  const vendor = user ? null : await withoutTenantScope(() => prisma.vendor.findFirst({
    where: { OR: [{ email: identifier.toLowerCase() }, { vendorId: identifier }] },
    omit: { password: false },
  }));

  const account = user || vendor;
  if (!account) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  // A tenant's subdomain is its front door: an account from another tenant is
  // not a wrong password, it is not an account here at all. The answer is the
  // same generic one either way, so the address does not report who exists
  // where. Only a real subdomain is strong enough to refuse — the development
  // fallback is a guess about which workspace was meant.
  const realm = await resolveRealmForRequest(req);
  if (realm.source === 'subdomain' && account.clientId !== realm.client?.clientId) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  const isMatch = await comparePassword(password, account.password);
  if (!isMatch) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  if (!canAuthenticate(account, user ? 'user' : 'vendor')) {
    return next(ApiError.forbidden('This account is not active'));
  }

  const client = await withoutTenantScope(() => prisma.client.findFirst({ where: { clientId: account.clientId } }));
  if (!client || !isClientOperational(client)) {
    return next(ApiError.forbidden('This workspace is not active'));
  }

  const table = user ? 'user' : 'vendor';
  const updated = await runWithTenant(account.clientId, () =>
    prisma[table].update({ where: { pk: account.pk }, data: { lastLoginAt: new Date() }, omit: { password: false } }));

  res.json({
    success: true,
    token: signToken(updated),
    mustChangePassword: Boolean(updated.mustChangePassword),
    role: updated.role,
    ...(user ? { user: formatUserResponse(updated) } : { vendor: formatVendorResponse(updated) })
  });
});

// @desc    Get the currently logged in principal
// @route   GET /api/auth/me
// @access  Private
const getMe = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    auth: req.auth,
    // The workspace the caller is in — the same shape the signed-out realm
    // endpoint serves, so a screen reads branding one way whoever is looking.
    workspace: describeWorkspace(req.client),
    ...(req.vendor
      ? { vendor: formatVendorResponse(req.vendor) }
      : { user: formatUserResponse(req.user) })
  });
});

const GENERIC_FORGOT_MESSAGE = 'If an account exists for this email, a password reset link has been sent.';

// Finds the identity that owns an email across both tenant-plane collections.
const findResettableAccount = async (email) => {
  const lowered = String(email || '').toLowerCase();
  const user = await withoutTenantScope(() => prisma.user.findFirst({ where: { email: lowered } }));
  if (user) return { account: user, kind: 'user' };
  const vendor = await withoutTenantScope(() => prisma.vendor.findFirst({ where: { email: lowered } }));
  return vendor ? { account: vendor, kind: 'vendor' } : { account: null, kind: null };
};

// @desc    Issue a time-limited password reset token and email it
// @route   POST /api/auth/forgot-password
// @access  Public
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const { account, kind } = await findResettableAccount(email);

  // Same response whether or not the email exists, so this endpoint can't be
  // used to enumerate accounts.
  if (!account || !canAuthenticate(account, kind)) {
    return res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
  }

  const { rawToken, fields } = issueResetToken();
  await withoutTenantScope(() => prisma[kind].update({ where: { pk: account.pk }, data: fields }));

  const resetUrl = `${frontendUrl()}/reset-password?token=${rawToken}`;

  // The link is emailed, never logged (ADR-0011).
  await sendMail({
    to: account.email,
    template: 'passwordReset',
    data: {
      name: account.name || account.companyName,
      resetUrl,
      expiresInMinutes: RESET_TOKEN_TTL_MS / 60000,
    },
  });
  logger.info(`Password reset email dispatched for account ${account.pk}`);

  res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });
});

// @desc    Reset a password using a token issued by forgotPassword
// @route   POST /api/auth/reset-password
// @access  Public
const resetPassword = asyncHandler(async (req, res, next) => {
  const { token, password } = req.body;
  const hashedToken = hashResetToken(String(token || ''));
  const criteria = { resetPasswordToken: hashedToken, resetPasswordExpires: { gt: new Date() } };

  let account = await withoutTenantScope(() => prisma.user.findFirst({ where: criteria }));
  let kind = 'user';
  if (!account) {
    account = await withoutTenantScope(() => prisma.vendor.findFirst({ where: criteria }));
    kind = 'vendor';
  }

  if (!account) {
    return next(ApiError.badRequest('Password reset token is invalid or has expired'));
  }

  // Single use: the token fields are cleared in the same update as the password.
  const fields = await consumeResetToken(password);
  await withoutTenantScope(() => prisma[kind].update({ where: { pk: account.pk }, data: fields }));

  res.json({ success: true, message: 'Password has been reset. You can now sign in.' });
});

// @desc    Change your own password (also clears a forced first-login change)
// @route   POST /api/auth/change-password
// @access  Private
const changePassword = asyncHandler(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  const kind = req.vendor ? 'vendor' : 'user';

  const account = await withoutTenantScope(() =>
    prisma[kind].findFirst({ where: { pk: req.auth.id }, omit: { password: false } }));
  if (!account) {
    return next(ApiError.unauthorized('Not authorized'));
  }

  if (!(await comparePassword(currentPassword, account.password))) {
    return next(ApiError.unauthorized('Current password is incorrect'));
  }

  const { password, passwordChangedAt } = await hashPassword(newPassword);
  await withoutTenantScope(() => prisma[kind].update({
    where: { pk: account.pk },
    data: { password, passwordChangedAt, mustChangePassword: false },
  }));

  res.json({ success: true, message: 'Password updated.' });
});

module.exports = {
  register,
  login,
  getMe,
  getWorkspace,
  describeWorkspace,
  forgotPassword,
  resetPassword,
  changePassword,
  formatVendorResponse,
  formatUserResponse,
};
