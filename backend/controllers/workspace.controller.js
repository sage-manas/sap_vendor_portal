const Vendor = require('../models/Vendor');
const RFQ = require('../models/RFQ');
const PurchaseOrder = require('../models/PurchaseOrder');
const Invoice = require('../models/Invoice');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../utils/audit');
const { formatAuditEntry, actionsForSubject, auditQuery } = require('../utils/auditView');
const { AUDIT_ACTIONS, AUDIT_SUBJECTS } = require('../config/auditActions');
const { describeSettings, applySettings, settingValue } = require('../config/tenantSettings');
const { VENDOR_STATUS, VENDOR_AWAITING_DECISION } = require('../config/statuses');
const { usageAgainstLimits } = require('../utils/usage');

// The tenant back office. Everything here runs inside a bound tenant, so there
// is no clientId parameter in this file: a client_admin sees their workspace
// and there is no request shape that asks for another one.

const workspaceIdentity = (client) => ({
  clientId: client.clientId,
  companyName: client.companyName,
  slug: client.slug,
  plan: client.plan,
  status: client.status,
  sapEnvironment: client.sapEnvironment,
  branding: {
    logo: settingValue(client, 'branding.logo'),
    primaryColor: settingValue(client, 'branding.primaryColor'),
  },
});

// @desc    The workspace overview: what needs a human, and how close the tenant
//          is to the limits the platform gave it.
// @route   GET /api/workspace/overview
// @access  dashboard:read
const getOverview = asyncHandler(async (req, res) => {
  const { client } = req;
  const slaHours = settingValue(client, 'thresholds.supplierApprovalSlaHours');
  const reviewAmount = settingValue(client, 'thresholds.invoiceReviewAmount');
  const slaCutoff = new Date(Date.now() - slaHours * 3600 * 1000);

  const [
    suppliersTotal,
    suppliersApproved,
    awaitingDecision,
    overdueDecision,
    openRfqs,
    openPos,
    invoicesOpen,
    invoicesOverThreshold,
    staffActive,
    pendingInvitations,
    usage,
  ] = await Promise.all([
    Vendor.countDocuments({}),
    Vendor.countDocuments({ status: VENDOR_STATUS.APPROVED }),
    Vendor.countDocuments({ status: { $in: VENDOR_AWAITING_DECISION } }),
    Vendor.countDocuments({ status: { $in: VENDOR_AWAITING_DECISION }, submittedAt: { $lt: slaCutoff } }),
    RFQ.countDocuments({ status: 'Bidding Open' }),
    PurchaseOrder.countDocuments({ status: { $in: ['Open', 'Acknowledged'] } }),
    Invoice.countDocuments({ status: { $nin: ['Cleared'] } }),
    Invoice.countDocuments({ status: { $nin: ['Cleared'] }, totalAmount: { $gte: reviewAmount } }),
    User.countDocuments({ status: 'Active' }),
    Invitation.countDocuments({ status: 'Pending' }),
    usageAgainstLimits(client),
  ]);

  res.json({
    success: true,
    workspace: workspaceIdentity(client),
    suppliers: {
      total: suppliersTotal,
      approved: suppliersApproved,
      awaitingDecision,
      overdueDecision,
      limit: client.limits?.vendors ?? null,
    },
    sourcing: { openRfqs, openPos },
    finance: { invoicesOpen, invoicesOverThreshold, reviewAmount },
    staff: { active: staffActive, pendingInvitations },
    thresholds: { supplierApprovalSlaHours: slaHours, invoiceReviewAmount: reviewAmount },
    usage,
  });
});

// @desc    This workspace's configuration, grouped as the screen renders it
// @route   GET /api/workspace/settings
// @access  settings:read
const getSettings = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    workspace: workspaceIdentity(req.client),
    groups: describeSettings(req.client),
  });
});

// @desc    Change this workspace's configuration
// @route   PATCH /api/workspace/settings
// @access  settings:manage
const updateSettings = asyncHandler(async (req, res, next) => {
  const patch = req.body?.settings;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return next(ApiError.badRequest('settings must be an object of { key: value }'));
  }

  let changed;
  try {
    changed = applySettings(req.client, patch);
  } catch (error) {
    if (!error.fields) throw error;
    // The same key → message shape a zod failure produces, so the settings
    // screen renders both kinds of refusal the same way.
    return next(ApiError.badRequest('One or more settings are invalid', { errors: error.fields }));
  }

  if (changed.length) {
    await req.client.save();
    // The keys that changed and their new values — a settings value is
    // configuration, never a secret, so it is recorded in full.
    await recordAudit({
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      req,
      target: { type: 'Client', id: req.client.clientId, label: req.client.companyName },
      meta: { changed, values: Object.fromEntries(changed.map((key) => [key, settingValue(req.client, key)])) },
    });
  }

  res.json({
    success: true,
    changed,
    workspace: workspaceIdentity(req.client),
    groups: describeSettings(req.client),
  });
});

// @desc    This workspace's own audit trail
// @route   GET /api/workspace/audit
// @access  audit:read
//
// Scoped to req.clientId, which comes from the token and never from the query:
// there is no parameter here that could name another tenant. Platform-plane
// rows are included — an operator suspending this workspace is its business —
// but the operator's identity is not (ADR-0025).
const listAudit = asyncHandler(async (req, res) => {
  const { action, subject, actorId } = req.query;
  const { range, perPage, currentPage, skip } = auditQuery(req.query, 100);

  const filter = { ...range, clientId: req.clientId };
  if (actorId) filter.actorId = actorId;
  if (action) filter.action = action;
  if (!action && subject) filter.action = { $in: actionsForSubject(subject) };

  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip(skip).limit(perPage),
    AuditLog.countDocuments(filter),
  ]);

  res.json({
    success: true,
    total,
    page: currentPage,
    limit: perPage,
    subjects: AUDIT_SUBJECTS,
    entries: entries.map((entry) => formatAuditEntry(entry, { revealPlatformActor: false })),
  });
});

module.exports = { getOverview, getSettings, updateSettings, listAudit };
