const { prisma } = require('../db/prisma');
const { hashPassword, comparePassword, burnPasswordCheck, issueResetToken, issueEmailVerification, consumeResetToken, hashResetToken, RESET_TOKEN_TTL_MS, EMAIL_VERIFICATION_TTL_MS } = require('../db/credentials');
const { canAuthenticate } = require('../db/accountHelpers');
const { isClientOperational } = require('../db/clientHelpers');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { resolveClientForRequest, resolveRealmForRequest } = require('../utils/resolveClient');
const { ROLES } = require('../config/roles');
const { signToken } = require('../utils/authToken');
// Called as mailer.sendMail so a test can stand in for the transport.
const mailer = require('../utils/mailer');
const { runInBackground } = require('../utils/background');
const { frontendUrl } = require('../config/emailTemplates');
const { generateVendorId, identityConflict } = require('../utils/vendorIdentity');
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

// What registration answers, whatever it found. A different answer for a taken
// email, GSTIN or vendor ID is how a stranger learns who has an account here
// (finding 1.4), so what actually happened is told to the mailbox owner by email
// and never to the caller.
const REGISTRATION_ACCEPTED = {
  success: true,
  message: 'Check your email to finish registering. If this address can be registered, a confirmation link is on its way.',
};

const stripUndefined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

// Everything registration does once it has answered. See `register`.
const processRegistration = async (client, body) => {
  const { password, companyName, gstin, pan, phone, address, city, state, postalCode, bankName, accountNumber, ifscCode, accountName, bankBranch } = body;
  const email = String(body.email).toLowerCase();
  const requestedId = body.vendorId;
  const mail = (template, data) => mailer.sendMail({ to: email, template, data });

  // An unconfirmed registration past its deadline is dead weight that also
  // holds its email, GSTIN and ID hostage — anyone can register an address they
  // do not own. Clearing it here means those identities are free again 24 hours
  // after the last attempt, and nothing needs a sweeper.
  await withoutTenantScope(() => prisma.vendor.deleteMany({
    where: {
      emailVerificationToken: { not: null },
      emailVerificationExpires: { lt: new Date() },
      OR: [
        { email },
        ...(requestedId ? [{ vendorId: requestedId }] : []),
        ...(gstin ? [{ clientId: client.clientId, gstin: String(gstin).toUpperCase() }] : []),
      ],
    },
  }));

  // A workspace can close self-service registration and admit suppliers by
  // invitation only (config/tenantSettings.js). An invited supplier is not
  // self-service, so their invitation is what reopens the door for them.
  if (!settingValue(client, 'features.supplierSelfRegistration')
    && !(await hasSupplierInvitation(client.clientId, email))) {
    return mail('registrationRefused', { workspaceName: client.companyName, reason: 'this workspace admits suppliers by invitation only.' });
  }

  // Still waiting for its link: send a fresh one, keeping the original deadline
  // and the original submission. Taking the new password or details would let
  // whoever registers an address first be overwritten by — or overwrite —
  // whoever registers it next, with nobody having proved the mailbox yet.
  const pending = await withoutTenantScope(() => prisma.vendor.findFirst({
    where: { email, emailVerificationToken: { not: null } },
    omit: { emailVerificationExpires: false },
  }));
  if (pending && pending.clientId === client.clientId) {
    const { rawToken, fields } = issueEmailVerification(pending.emailVerificationExpires);
    await withoutTenantScope(() => prisma.vendor.update({ where: { pk: pending.pk }, data: fields }));
    return mail('registrationConfirm', {
      companyName: pending.companyName,
      workspaceName: client.companyName,
      confirmUrl: `${frontendUrl()}/confirm-email?token=${rawToken}`,
      expiresInHours: Math.max(1, Math.round((pending.emailVerificationExpires - Date.now()) / 3600000)),
    });
  }

  // vendorId/email are global login identities; gstin is checked within this
  // workspace only — a supplier trading with two buyers registers under the
  // same real GSTIN in each (issue #67, ADR-0039).
  const conflict = await identityConflict({ vendorId: requestedId, email, gstin, clientId: client.clientId });
  if (conflict === 'email') {
    return mail('registrationExisting', {
      signInUrl: `${frontendUrl()}/sign-in`,
      resetUrl: `${frontendUrl()}/forgot-password`,
    });
  }
  if (conflict) {
    return mail('registrationRefused', {
      workspaceName: client.companyName,
      reason: conflict === 'gstin'
        ? 'a supplier with this GSTIN is already registered.'
        : 'the supplier ID that was asked for is already taken.',
    });
  }

  const vendorId = requestedId || await generateVendorId();

  // Freshly self-registered vendors start as a Draft until they complete
  // and submit the full onboarding form.
  const defaultStatus = vendorId.startsWith('mock_vendor_') ? 'Pending' : 'Draft';

  const { password: hashedPassword, passwordChangedAt } = await hashPassword(password);
  const { rawToken, fields } = issueEmailVerification();

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
      ...stripUndefined({ phone, address, city, state, postalCode, bankName, accountNumber, ifscCode, accountName, bankBranch }),
      status: defaultStatus,
      role: ROLES.VENDOR,
      ...fields,
    },
  }));

  await mail('registrationConfirm', {
    companyName: vendor.companyName,
    workspaceName: client.companyName,
    confirmUrl: `${frontendUrl()}/confirm-email?token=${rawToken}`,
    expiresInHours: EMAIL_VERIFICATION_TTL_MS / 3600000,
  });
};

// @desc    Register a new vendor
// @route   POST /api/auth/register
// @access  Public
//
// Always answers 202 with the same body and does its work afterwards: the
// account is created pending, and cannot sign in until the emailed link is
// followed (confirmEmail). No session is issued here.
const register = asyncHandler(async (req, res, next) => {
  // Which workspace is this supplier registering into? (Subdomain in Phase 6;
  // header/DEFAULT_CLIENT_SLUG/legacy until then.) These answer for the
  // address being visited, not for the email being registered.
  const client = await resolveClientForRequest(req);
  if (!client) {
    return next(ApiError.notFound('Unknown workspace'));
  }
  if (!isClientOperational(client)) {
    return next(ApiError.forbidden('This workspace is not accepting registrations'));
  }

  // Before any lookup of the submitted identity, so a workspace at its plan
  // limit answers every caller the same way.
  await assertCanCreate(client, 'vendors');

  res.status(202).json(REGISTRATION_ACCEPTED);
  runInBackground('register', () => processRegistration(client, req.body));
});

// @desc    Confirm a self-registration from the emailed link
// @route   POST /api/auth/confirm-email
// @access  Public
//
// The token alone is not enough: the password chosen at registration is asked
// for too. Without it, whoever registers an address they do not own could wait
// for the owner to click an emailed link and be handed the account.
const confirmEmail = asyncHandler(async (req, res, next) => {
  const { token, password } = req.body;

  const vendor = await withoutTenantScope(() => prisma.vendor.findFirst({
    where: { emailVerificationToken: hashResetToken(token), emailVerificationExpires: { gt: new Date() } },
    omit: { password: false },
  }));

  // One answer for an unknown token, an expired one and a wrong password.
  const refusal = ApiError.badRequest(
    'This confirmation link is invalid or has expired, or the password does not match the one chosen at registration.',
    { reason: 'invalid_confirmation' },
  );
  if (!vendor) {
    await burnPasswordCheck(password);
    return next(refusal);
  }
  if (!(await comparePassword(password, vendor.password))) {
    return next(refusal);
  }

  await withoutTenantScope(() => prisma.vendor.update({
    where: { pk: vendor.pk },
    data: { emailVerificationToken: null, emailVerificationExpires: null },
  }));

  res.json({ success: true, message: 'Email confirmed. You can now sign in.' });
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

  // An address that names no workspace (an unknown subdomain, the bare domain)
  // is not a wrong password: there is nothing here to sign in to.
  if (!(await resolveRealmForRequest(req)).client) {
    return next(ApiError.notFound('Unknown workspace'));
  }

  // Login precedes tenancy — the account itself carries the clientId that every
  // later request is bound to. Staff sign in with an email; suppliers with
  // either their email or their vendorId.
  const user = await withoutTenantScope(() =>
    prisma.user.findFirst({ where: { email: identifier.toLowerCase() }, omit: { password: false } }));

  const vendor = user ? null : await withoutTenantScope(() => prisma.vendor.findFirst({
    where: { OR: [{ email: identifier.toLowerCase() }, { vendorId: identifier }] },
    omit: { password: false, emailVerificationToken: false },
  }));

  const account = user || vendor;
  if (!account) {
    // Same work as a wrong password, so the response time does not say the
    // account does not exist.
    await burnPasswordCheck(password);
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  // A tenant's subdomain is its front door: an account from another tenant is
  // not a wrong password, it is not an account here at all. The answer is the
  // same generic one either way, so the address does not report who exists
  // where. Only a real subdomain is strong enough to refuse — the development
  // fallback is a guess about which workspace was meant.
  const realm = await resolveRealmForRequest(req);
  if (realm.source === 'subdomain' && account.clientId !== realm.client?.clientId) {
    await burnPasswordCheck(password);
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  const isMatch = await comparePassword(password, account.password);
  if (!isMatch) {
    return next(ApiError.unauthorized('Invalid credentials'));
  }

  if (!canAuthenticate(account, user ? 'user' : 'vendor')) {
    return next(ApiError.forbidden('This account is not active'));
  }

  // A self-registration that has not followed its emailed link. Said only after
  // the password was right, so it does not tell a stranger the account exists.
  if (vendor?.emailVerificationToken) {
    return next(ApiError.forbidden(
      'Confirm your email address to sign in. The link was sent when you registered.',
      { reason: 'email_unconfirmed' },
    ));
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

  // Answered before the token is written and the email is sent. That work is
  // the only difference between a real address and an unknown one, and doing it
  // first made the difference measurable from outside (finding 1.4).
  res.json({ success: true, message: GENERIC_FORGOT_MESSAGE });

  runInBackground('forgot-password', async () => {
    const { rawToken, fields } = issueResetToken();
    await withoutTenantScope(() => prisma[kind].update({ where: { pk: account.pk }, data: fields }));

    const resetUrl = `${frontendUrl()}/reset-password?token=${rawToken}`;

    // The link is emailed, never logged (ADR-0011).
    await mailer.sendMail({
      to: account.email,
      template: 'passwordReset',
      data: {
        name: account.name || account.companyName,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MS / 60000,
      },
    });
    logger.info(`Password reset email dispatched for account ${account.pk}`);
  });
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
  // A reset link only reaches the mailbox's owner, which is what confirming a
  // registration proves — so it confirms a pending one too.
  if (kind === 'vendor') Object.assign(fields, { emailVerificationToken: null, emailVerificationExpires: null });
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
  const updated = await withoutTenantScope(() => prisma[kind].update({
    where: { pk: account.pk },
    data: { password, passwordChangedAt, mustChangePassword: false },
  }));

  // middleware/auth.js's resolveAccountFromToken (issue #74) now rejects any
  // token issued before this account's passwordChangedAt — correctly, for a
  // token that isn't the caller's own, but this request's own bearer token
  // was just issued before the write above completed. Without a fresh one,
  // the legitimate caller who just changed their own password is logged out
  // by their own action, non-deterministically (only when passwordChangedAt
  // and the old token's second-resolution `iat` land in different seconds —
  // exactly the gap between "changed just now" and "changed sometime in the
  // last few hundred milliseconds"). Minting a new token here is the
  // difference between ending every *other* session and ending this one too.
  res.json({ success: true, message: 'Password updated.', token: signToken(updated) });
});

module.exports = {
  register,
  confirmEmail,
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
