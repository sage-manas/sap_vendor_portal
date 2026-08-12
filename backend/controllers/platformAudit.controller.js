const AuditLog = require('../models/AuditLog');
const Client = require('../models/Client');
const asyncHandler = require('../utils/asyncHandler');
const { withoutTenantScope } = require('../utils/tenantContext');
const { ALL_AUDIT_ACTIONS, AUDIT_SUBJECTS } = require('../config/auditActions');

// The audit explorer. Reads across every tenant, which is the one thing the
// platform plane is for — and reads *only* the trail: an entry says that a
// tenant's configuration changed and who changed it, never what is in that
// tenant's RFQs.
//
// Phase 4 adds SapConnectionAudit as a second source; the response shape
// already carries a `source` on every row so the union needs no client change.

const formatEntry = (entry) => ({
  id: entry._id,
  source: 'audit',
  at: entry.at,
  clientId: entry.clientId,
  action: entry.action,
  actor: { id: entry.actorId, email: entry.actorEmail, role: entry.actorRole, plane: entry.plane },
  target: entry.target || null,
  meta: entry.meta || {},
  ip: entry.ip,
});

// @desc    Query the audit trail
// @route   GET /api/platform/audit
// @access  platform:audit:read
const listAudit = asyncHandler(async (req, res) => {
  const { clientId, action, subject, actorId, plane, from, to, page = 1, limit = 50 } = req.query;

  const filter = {};
  if (clientId) filter.clientId = clientId;
  if (actorId) filter.actorId = actorId;
  if (plane) filter.plane = plane;
  if (action) filter.action = action;
  // "Everything that happened to tenants" — the subject is the action prefix,
  // matched against the registry rather than by a regex over user input.
  if (!action && subject) {
    filter.action = { $in: ALL_AUDIT_ACTIONS.filter((entry) => entry.startsWith(`${subject}.`)) };
  }
  if (from || to) {
    filter.at = {
      ...(from && { $gte: new Date(from) }),
      ...(to && { $lte: new Date(to) }),
    };
  }

  const perPage = Math.min(Number(limit) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

  const [entries, total] = await Promise.all([
    AuditLog.find(filter).sort({ at: -1 }).skip(skip).limit(perPage),
    AuditLog.countDocuments(filter),
  ]);

  res.json({
    success: true,
    total,
    page: Math.max(Number(page) || 1, 1),
    limit: perPage,
    entries: entries.map(formatEntry),
  });
});

// @desc    The values the explorer's filters offer
// @route   GET /api/platform/audit/filters
// @access  platform:audit:read
//
// Served from the registries, not from a distinct() over the data: a filter
// list built from what has happened so far hides the actions that have not
// happened yet, which are exactly the ones an operator is hunting for.
const auditFilters = asyncHandler(async (req, res) => {
  const clients = await withoutTenantScope(() =>
    Client.find({}).select('clientId companyName').sort({ clientId: 1 }));

  res.json({
    success: true,
    actions: ALL_AUDIT_ACTIONS,
    subjects: AUDIT_SUBJECTS,
    planes: ['platform', 'tenant', 'supplier', 'system'],
    tenants: clients.map((client) => ({ clientId: client.clientId, companyName: client.companyName })),
  });
});

module.exports = { listAudit, auditFilters };
