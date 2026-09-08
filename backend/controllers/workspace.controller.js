const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../utils/audit');
const { formatAuditEntry, actionsForSubject, auditQuery } = require('../utils/auditView');
const { AUDIT_ACTIONS, AUDIT_SUBJECTS } = require('../config/auditActions');
const { describeSettings, applySettings, settingValue, topLevelFieldsFor } = require('../config/tenantSettings');
const { VENDOR_STATUS, VENDOR_AWAITING_DECISION } = require('../config/statuses');
const { usageAgainstLimits } = require('../utils/usage');
const { toNumber } = require('../utils/money');

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
    rfqsTotal,
    openRfqs,
    awardedRfqs,
    posTotal,
    openPos,
    invoicesTotal,
    invoicesOpen,
    invoicesOverThreshold,
    invoicesOpenValue,
    paymentTotals,
    staffActive,
    pendingInvitations,
    usage,
  ] = await Promise.all([
    prisma.vendor.count({}),
    prisma.vendor.count({ where: { status: VENDOR_STATUS.APPROVED } }),
    prisma.vendor.count({ where: { status: { in: VENDOR_AWAITING_DECISION } } }),
    prisma.vendor.count({ where: { status: { in: VENDOR_AWAITING_DECISION }, submittedAt: { lt: slaCutoff } } }),
    // Sourcing and finance below are deliberately tenant-wide, not scoped to
    // any one vendor — this endpoint runs for client_admin/buyer/finance, and
    // "how is sourcing/finance doing" means across every supplier in the
    // tenant, the same way the supplier counts above already are.
    prisma.rFQ.count({}),
    prisma.rFQ.count({ where: { status: 'Bidding Open' } }),
    prisma.rFQ.count({ where: { status: 'Awarded' } }),
    prisma.purchaseOrder.count({}),
    prisma.purchaseOrder.count({ where: { status: { in: ['Open', 'Acknowledged'] } } }),
    prisma.invoice.count({}),
    prisma.invoice.count({ where: { status: { notIn: ['Cleared'] } } }),
    prisma.invoice.count({ where: { status: { notIn: ['Cleared'] }, totalAmount: { gte: reviewAmount } } }),
    prisma.invoice.aggregate({ where: { status: { notIn: ['Cleared'] } }, _sum: { totalAmount: true } }),
    // count/sum in one round trip rather than four separate counts+aggregates.
    prisma.payment.aggregate({ _count: true, _sum: { grossAmount: true, netAmount: true, tdsDeducted: true } }),
    prisma.user.count({ where: { status: 'Active' } }),
    prisma.invitation.count({ where: { status: 'Pending' } }),
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
      limit: client.limitVendors ?? null,
    },
    sourcing: { rfqsTotal, openRfqs, awardedRfqs, posTotal, openPos },
    finance: {
      invoicesTotal,
      invoicesOpen,
      invoicesOverThreshold,
      invoicesOpenValue: toNumber(invoicesOpenValue._sum.totalAmount) || 0,
      reviewAmount,
      payments: {
        count: paymentTotals._count,
        grossPaid: toNumber(paymentTotals._sum.grossAmount) || 0,
        netPaid: toNumber(paymentTotals._sum.netAmount) || 0,
        tdsDeducted: toNumber(paymentTotals._sum.tdsDeducted) || 0,
      },
    },
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

  // applySettings mutates a plain-object copy of req.client in place; the
  // Prisma row itself is only written below, once, with just the top-level
  // columns (settings/featureFlags/brandingLogo/brandingColor) those changed
  // keys actually touched.
  const working = { ...req.client };
  let changed;
  try {
    changed = applySettings(working, patch);
  } catch (error) {
    if (!error.fields) throw error;
    // The same key → message shape a zod failure produces, so the settings
    // screen renders both kinds of refusal the same way.
    return next(ApiError.badRequest('One or more settings are invalid', { errors: error.fields }));
  }

  let client = req.client;
  if (changed.length) {
    const fields = topLevelFieldsFor(changed);
    const data = Object.fromEntries(fields.map((field) => [field, working[field]]));
    client = await prisma.client.update({ where: { pk: req.client.pk }, data });

    // The keys that changed and their new values — a settings value is
    // configuration, never a secret, so it is recorded in full.
    await recordAudit({
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      req,
      target: { type: 'Client', id: client.clientId, label: client.companyName },
      meta: { changed, values: Object.fromEntries(changed.map((key) => [key, settingValue(client, key)])) },
    });
  }

  res.json({
    success: true,
    changed,
    workspace: workspaceIdentity(client),
    groups: describeSettings(client),
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

  const where = { ...range, clientId: req.clientId };
  if (actorId) where.actorId = actorId;
  if (action) where.action = action;
  if (!action && subject) where.action = { in: actionsForSubject(subject) };

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { at: 'desc' }, skip, take: perPage }),
    prisma.auditLog.count({ where }),
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
