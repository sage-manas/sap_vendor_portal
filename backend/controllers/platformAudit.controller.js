const AuditLog = require('../models/AuditLog');
const Client = require('../models/Client');
const asyncHandler = require('../utils/asyncHandler');
const { withoutTenantScope } = require('../utils/tenantContext');
const { ALL_AUDIT_ACTIONS, AUDIT_SUBJECTS } = require('../config/auditActions');
const { formatAuditEntry, actionsForSubject, auditQuery } = require('../utils/auditView');

// The audit explorer. Reads across every tenant, which is the one thing the
// platform plane is for — and reads *only* the trail: an entry says that a
// tenant's configuration changed and who changed it, never what is in that
// tenant's RFQs.
//
// Phase 4 adds SapConnectionAudit as a second source; the response shape
// already carries a `source` on every row so the union needs no client change.

// @desc    Query the audit trail
// @route   GET /api/platform/audit
// @access  platform:audit:read
const listAudit = asyncHandler(async (req, res) => {
  const { clientId, action, subject, actorId, plane } = req.query;
  const { range, perPage, currentPage, skip } = auditQuery(req.query);

  const filter = { ...range };
  if (clientId) filter.clientId = clientId;
  if (actorId) filter.actorId = actorId;
  if (plane) filter.plane = plane;
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
    entries: entries.map((entry) => formatAuditEntry(entry)),
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
