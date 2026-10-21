const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../utils/audit');
const { formatAuditEntry, actionsForSubject, auditQuery } = require('../utils/auditView');
const { AUDIT_ACTIONS, AUDIT_SUBJECTS } = require('../config/auditActions');
const { describeSettings, applySettings, settingValue, topLevelFieldsFor } = require('../config/tenantSettings');
const {
  VENDOR_STATUS, VENDOR_AWAITING_DECISION, INVOICE_OPEN, PO_AWAITING_SUPPLIER, RFQ_STATUS,
} = require('../config/statuses');
const { usageAgainstLimits } = require('../utils/usage');
const { openInvoiceValue } = require('../services/supplierSummary.service');
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
    invoicesOverThreshold,
    openInvoices,
    invoicesOpenFaceValue,
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
    prisma.rFQ.count({ where: { status: RFQ_STATUS.BIDDING_OPEN } }),
    prisma.rFQ.count({ where: { status: RFQ_STATUS.AWARDED } }),
    prisma.purchaseOrder.count({}),
    // The status groups here come from the registry rather than an inline
    // list, because each of these tiles now links to its list filtered the
    // same way (issue #281): the tile's number and the list's
    // `pagination.total` are two reads of one definition, and they have to
    // stay one definition to keep agreeing.
    prisma.purchaseOrder.count({ where: { status: { in: PO_AWAITING_SUPPLIER } } }),
    prisma.invoice.count({}),
    // These said `notIn: ['Cleared']`, which counts a *Rejected* invoice as
    // money the buyer still owes — issue #283, here in the one place a reader
    // meets it as a headline figure. INVOICE_OPEN is the honest set: in the
    // buyer's hands and still owed. The review threshold is deliberately read
    // against `totalAmount`: what a human is asked to approve is the invoice
    // as raised, not whatever is left on it after a part payment.
    prisma.invoice.count({ where: { status: { in: INVOICE_OPEN }, totalAmount: { gte: reviewAmount } } }),
    // The other half of #283: the count and the value both come from the
    // shared helper, which nets off every PaymentItem against its invoice. A
    // half-paid ₹1,00,000 invoice used to read as ₹1,00,000 awaiting.
    openInvoiceValue({}),
    // Face value of the same set, kept alongside it: "₹X owed across invoices
    // worth ₹Y" is two different true statements, and the screen says which
    // is which rather than the figure quietly meaning one of them.
    prisma.invoice.aggregate({ where: { status: { in: INVOICE_OPEN } }, _sum: { totalAmount: true } }),
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
      invoicesOpen: openInvoices.count,
      invoicesOverThreshold,
      // Still owed, net of part payments.
      invoicesOpenValue: openInvoices.value,
      // The same invoices at face value, before anything paid against them.
      invoicesOpenFaceValue: toNumber(invoicesOpenFaceValue._sum.totalAmount) || 0,
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
