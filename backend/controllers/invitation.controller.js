const Invitation = require('../models/Invitation');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Client = require('../models/Client');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withoutTenantScope, runWithTenant } = require('../utils/tenantContext');
const { TENANT_ROLES, ROLES, planeOf, PLANES } = require('../config/roles');
const { sendMail } = require('../utils/mailer');
const { signToken } = require('../utils/authToken');
const { frontendUrl } = require('../config/emailTemplates');

const { hashInviteToken, newInviteToken } = Invitation;

const publicInvitation = (invitation, client) => ({
  email: invitation.email,
  name: invitation.name || '',
  role: invitation.role,
  companyName: client?.companyName || '',
  expiresAt: invitation.expiresAt,
});

// An email may hold exactly one account across the platform: login resolves it
// before any tenant is known.
const emailIsTaken = async (email) => {
  const lowered = email.toLowerCase();
  const user = await withoutTenantScope(() => User.findOne({ email: lowered }));
  if (user) return true;
  return Boolean(await withoutTenantScope(() => Vendor.findOne({ email: lowered })));
};

const createInvitation = async ({ req, email, name, role }) => {
  if (await emailIsTaken(email)) {
    throw ApiError.conflict('An account already exists for this email');
  }

  // One live invitation per email per tenant: re-inviting supersedes the old
  // token rather than leaving two valid links in two inboxes.
  await Invitation.updateMany(
    { email: email.toLowerCase(), status: 'Pending' },
    { $set: { status: 'Revoked', revokedAt: new Date() } }
  );

  const { rawToken, tokenHash, expiresAt } = newInviteToken();
  const invitation = await Invitation.create({
    email: email.toLowerCase(),
    name,
    role,
    tokenHash,
    expiresAt,
    invitedBy: req.auth.email,
  });

  await sendMail({
    to: invitation.email,
    template: 'invitation',
    data: {
      name,
      inviterName: req.auth.email,
      companyName: req.client?.companyName || 'your workspace',
      role,
      acceptUrl: `${frontendUrl()}/accept-invitation?token=${rawToken}`,
    },
  });

  return invitation;
};

// @desc    Invite a member of tenant staff (buyer / finance / client_admin)
// @route   POST /api/users/invitations
// @access  user:invite
const inviteUser = asyncHandler(async (req, res, next) => {
  const { email, name, role } = req.body;
  if (!TENANT_ROLES.includes(role)) {
    return next(ApiError.badRequest(`role must be one of: ${TENANT_ROLES.join(', ')}`));
  }
  const invitation = await createInvitation({ req, email, name, role });
  res.status(201).json({ success: true, invitation: publicInvitation(invitation, req.client) });
});

// @desc    Invite a supplier into this tenant's workspace
// @route   POST /api/vendors/invitations
// @access  vendor:invite
const inviteVendor = asyncHandler(async (req, res, next) => {
  const { email, name } = req.body;
  const invitation = await createInvitation({ req, email, name, role: ROLES.VENDOR });
  res.status(201).json({ success: true, invitation: publicInvitation(invitation, req.client) });
});

// @desc    List this tenant's invitations
// @route   GET /api/users/invitations
// @access  user:read
const listInvitations = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const invitations = await Invitation.find(status ? { status } : {}).sort({ createdAt: -1 });
  res.json({ success: true, invitations });
});

// @desc    Revoke a pending invitation
// @route   DELETE /api/users/invitations/:id
// @access  user:manage
const revokeInvitation = asyncHandler(async (req, res, next) => {
  const invitation = await Invitation.findById(req.params.id);
  if (!invitation) {
    return next(ApiError.notFound('Invitation not found'));
  }
  if (invitation.status !== 'Pending') {
    return next(ApiError.badRequest('Only a pending invitation can be revoked'));
  }
  invitation.status = 'Revoked';
  invitation.revokedAt = new Date();
  await invitation.save();
  res.json({ success: true, invitation: publicInvitation(invitation, req.client) });
});

// Looks an invitation up by raw token. Pre-authentication, so it is one of the
// few deliberately unscoped reads — the invitation itself names the tenant.
const findByToken = async (rawToken) => {
  const tokenHash = hashInviteToken(String(rawToken || ''));
  const invitation = await withoutTenantScope(() => Invitation.findOne({ tokenHash }));
  if (!invitation || !invitation.isRedeemable()) return null;
  const client = await withoutTenantScope(() => Client.findOne({ clientId: invitation.clientId }));
  if (!client || !client.isOperational()) return null;
  return { invitation, client };
};

// @desc    Look up an invitation so the accept screen can render
// @route   GET /api/auth/invitations/:token
// @access  Public
const getInvitation = asyncHandler(async (req, res, next) => {
  const found = await findByToken(req.params.token);
  if (!found) {
    return next(ApiError.badRequest('This invitation is invalid or has expired'));
  }
  res.json({ success: true, invitation: publicInvitation(found.invitation, found.client) });
});

// @desc    Accept an invitation and create the account it describes
// @route   POST /api/auth/invitations/accept
// @access  Public
const acceptInvitation = asyncHandler(async (req, res, next) => {
  const { token, password, name } = req.body;

  const found = await findByToken(token);
  if (!found) {
    return next(ApiError.badRequest('This invitation is invalid or has expired'));
  }
  const { invitation, client } = found;

  if (await emailIsTaken(invitation.email)) {
    return next(ApiError.conflict('An account already exists for this email'));
  }

  // Supplier invitations hand off to self-registration: the supplier still has
  // to complete the onboarding form, and duplicating its field list here is
  // exactly what Phase 5 forbids.
  if (planeOf(invitation.role) === PLANES.SUPPLIER) {
    invitation.acceptedAt = new Date();
    invitation.status = 'Accepted';
    await runWithTenant(client.clientId, () => invitation.save());
    return res.json({
      success: true,
      next: 'register',
      workspace: { slug: client.slug, companyName: client.companyName },
      email: invitation.email,
    });
  }

  const account = await runWithTenant(client.clientId, async () => {
    const user = await User.create({
      email: invitation.email,
      name: name || invitation.name || invitation.email,
      role: invitation.role,
      status: 'Active',
      password,
      invitedBy: invitation.invitedBy,
      invitedAt: invitation.createdAt,
      activatedAt: new Date(),
    });

    invitation.status = 'Accepted';
    invitation.acceptedAt = new Date();
    invitation.acceptedAccountId = String(user._id);
    await invitation.save();

    return user;
  });

  res.status(201).json({
    success: true,
    token: signToken(account),
    user: { id: account._id, email: account.email, name: account.name, role: account.role },
  });
});

module.exports = {
  inviteUser,
  inviteVendor,
  listInvitations,
  revokeInvitation,
  getInvitation,
  acceptInvitation,
};
