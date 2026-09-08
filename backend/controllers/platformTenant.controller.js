const { prisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { runWithTenant } = require('../utils/tenantContext');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { tenantModels } = require('../config/tenantModels');
const { ROLES } = require('../config/roles');
const {
  provisionTenant,
  reissueAdminCredentials,
} = require('../services/tenantProvisioning.service');
const { getBillingProvider } = require('../services/billing.service');
const { usageAgainstLimits } = require('../utils/usage');

// Tenant administration for the platform console.
//
// Everything here reads and writes tenant *configuration*. Not one endpoint
// returns an RFQ, a PO or an invoice: the per-tenant numbers below are counts
// and totals, produced by `count` inside the tenant's own scope, and the
// export is an explicit, audited operator action rather than a browse.

const STATUS = { TRIAL: 'Trial', ACTIVE: 'Active', SUSPENDED: 'Suspended', TERMINATED: 'Terminated' };

// The shape the console renders. Everything on Client is operator-visible —
// there is no secret on this model (SAP credentials live on SapConnection,
// encrypted and never returned).
const formatClient = (client) => ({
  clientId: client.clientId,
  companyName: client.companyName,
  slug: client.slug,
  status: client.status,
  plan: client.plan,
  branding: { logo: client.brandingLogo ?? null, primaryColor: client.brandingColor ?? null },
  featureFlags: client.featureFlags || {},
  limits: {
    vendors: client.limitVendors,
    rfqsPerMonth: client.limitRfqsPerMonth,
    storageMb: client.limitStorageMb,
  },
  createdBy: client.createdBy,
  createdAt: client.createdAt,
  activatedAt: client.activatedAt,
  suspendedAt: client.suspendedAt,
  terminatedAt: client.terminatedAt,
});

// Counts one tenant's rows, inside that tenant's scope so the extension does
// the filtering rather than a hand-written clientId that could be forgotten.
const countsFor = (clientId) =>
  runWithTenant(clientId, async () => {
    const entries = await Promise.all(
      tenantModels().map(async ({ name, count }) => [name, await count()])
    );
    return Object.fromEntries(entries);
  });

const findClientOr404 = async (clientId) => {
  const client = await prisma.client.findFirst({ where: { clientId } });
  if (!client) throw ApiError.notFound('Not found');
  return client;
};

// @desc    List tenants
// @route   GET /api/platform/tenants
// @access  tenant:read
const listTenants = asyncHandler(async (req, res) => {
  const { status, plan, q, page = 1, limit = 25 } = req.query;

  const where = {};
  if (status) where.status = status;
  if (plan) where.plan = plan;
  if (q) {
    const term = String(q);
    where.OR = [
      { companyName: { contains: term, mode: 'insensitive' } },
      { slug: { contains: term, mode: 'insensitive' } },
      { clientId: { contains: term, mode: 'insensitive' } },
    ];
  }

  const perPage = Math.min(Number(limit) || 25, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

  const [clients, total] = await Promise.all([
    prisma.client.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: perPage }),
    prisma.client.count({ where }),
  ]);

  res.json({
    success: true,
    total,
    page: Math.max(Number(page) || 1, 1),
    limit: perPage,
    tenants: clients.map(formatClient),
  });
});

// @desc    One tenant, with its administrators and row counts
// @route   GET /api/platform/tenants/:clientId
// @access  tenant:read
const getTenant = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);

  const admins = await runWithTenant(client.clientId, () =>
    prisma.user.findMany({
      where: { role: ROLES.CLIENT_ADMIN },
      select: { pk: true, email: true, name: true, status: true, lastLoginAt: true, mustChangePassword: true, createdAt: true },
    }));

  res.json({
    success: true,
    tenant: formatClient(client),
    administrators: admins.map((admin) => ({
      id: admin.pk,
      email: admin.email,
      name: admin.name,
      status: admin.status,
      lastLoginAt: admin.lastLoginAt,
      mustChangePassword: admin.mustChangePassword,
      createdAt: admin.createdAt,
    })),
    counts: await countsFor(client.clientId),
  });
});

// @desc    Create a tenant and issue its first client_admin credentials
// @route   POST /api/platform/tenants
// @access  tenant:manage
const createTenant = asyncHandler(async (req, res) => {
  const { companyName, slug, plan, limits, branding, featureFlags, admin } = req.body;

  const { client, clientAdmin } = await provisionTenant({
    companyName, slug, plan, limits, branding, featureFlags, admin,
    createdBy: req.auth.email,
  });

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.TENANT_CREATED,
    clientId: client.clientId,
    target: { type: 'Client', id: client.clientId, label: client.companyName },
    meta: { slug: client.slug, plan: client.plan },
  });
  await recordAudit({
    req,
    action: AUDIT_ACTIONS.TENANT_ADMIN_PROVISIONED,
    clientId: client.clientId,
    target: { type: 'User', id: clientAdmin.pk, label: clientAdmin.email },
    // The password is not here, and cannot be: provisionTenant never returns it.
    meta: { role: clientAdmin.role, delivery: 'email' },
  });

  await getBillingProvider().onTenantCreated({ client });

  res.status(201).json({
    success: true,
    tenant: formatClient(client),
    administrator: { id: clientAdmin.pk, email: clientAdmin.email, name: clientAdmin.name },
    message: `Workspace created. Credentials have been emailed to ${clientAdmin.email}.`,
  });
});

// Fields an operator may change after creation. `clientId` and `slug` are
// absent on purpose: the first identifies the tenant everywhere, the second is
// its login realm, and both are load-bearing for data already written.
// Maps a request-body field to how it lands on the flattened Client columns —
// `limits`/`branding` were nested Mongoose subdocuments and are now separate
// scalar columns (see prisma/schema.prisma), so editing them is a merge
// across several `data` keys rather than one.
const applyLimitsPatch = (client, patch = {}) => ({
  ...(patch.vendors !== undefined && { limitVendors: patch.vendors }),
  ...(patch.rfqsPerMonth !== undefined && { limitRfqsPerMonth: patch.rfqsPerMonth }),
  ...(patch.storageMb !== undefined && { limitStorageMb: patch.storageMb }),
});

const applyBrandingPatch = (client, patch = {}) => ({
  ...(patch.logo !== undefined && { brandingLogo: patch.logo }),
  ...(patch.primaryColor !== undefined && { brandingColor: patch.primaryColor }),
});

// @desc    Edit a tenant's configuration
// @route   PUT /api/platform/tenants/:clientId
// @access  tenant:manage
const updateTenant = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);

  const data = {};
  const changed = {};

  if (req.body.companyName !== undefined) {
    changed.companyName = { from: client.companyName, to: req.body.companyName };
    data.companyName = req.body.companyName;
  }
  if (req.body.plan !== undefined) {
    changed.plan = { from: client.plan, to: req.body.plan };
    data.plan = req.body.plan;
  }
  if (req.body.limits !== undefined) {
    const before = { vendors: client.limitVendors, rfqsPerMonth: client.limitRfqsPerMonth, storageMb: client.limitStorageMb };
    changed.limits = { from: before, to: { ...before, ...req.body.limits } };
    Object.assign(data, applyLimitsPatch(client, req.body.limits));
  }
  if (req.body.branding !== undefined) {
    const before = { logo: client.brandingLogo, primaryColor: client.brandingColor };
    changed.branding = { from: before, to: { ...before, ...req.body.branding } };
    Object.assign(data, applyBrandingPatch(client, req.body.branding));
  }
  if (req.body.featureFlags !== undefined) {
    const next = { ...(client.featureFlags || {}), ...req.body.featureFlags };
    changed.featureFlags = { from: client.featureFlags, to: next };
    data.featureFlags = next;
  }

  if (!Object.keys(changed).length) {
    return res.json({ success: true, tenant: formatClient(client) });
  }

  const updated = await prisma.client.update({ where: { pk: client.pk }, data });
  await recordAudit({
    req,
    action: AUDIT_ACTIONS.TENANT_UPDATED,
    clientId: client.clientId,
    target: { type: 'Client', id: client.clientId, label: client.companyName },
    meta: { fields: Object.keys(changed), changed },
  });

  res.json({ success: true, tenant: formatClient(updated) });
});

// The three lifecycle moves, each expressed as "from these states, to that
// state, stamping this date and recording this action". Kept as data so the
// legal transitions are readable in one place instead of spread over three
// near-identical handlers.
const TRANSITIONS = {
  suspend: {
    to: STATUS.SUSPENDED,
    from: [STATUS.TRIAL, STATUS.ACTIVE],
    past: 'suspended',
    stamp: 'suspendedAt',
    action: AUDIT_ACTIONS.TENANT_SUSPENDED,
    message: 'Workspace suspended. Its users can no longer sign in.',
  },
  reactivate: {
    to: STATUS.ACTIVE,
    from: [STATUS.SUSPENDED],
    past: 'reactivated',
    stamp: 'activatedAt',
    action: AUDIT_ACTIONS.TENANT_REACTIVATED,
    message: 'Workspace reactivated.',
  },
  terminate: {
    to: STATUS.TERMINATED,
    from: [STATUS.TRIAL, STATUS.ACTIVE, STATUS.SUSPENDED],
    past: 'terminated',
    stamp: 'terminatedAt',
    action: AUDIT_ACTIONS.TENANT_TERMINATED,
    message: 'Workspace terminated. Its data is retained and exportable; nobody can sign in.',
  },
};

// Termination is soft, always: the data stays, the door closes. Deleting a
// tenant's documents is not an API operation — it is a deliberate,
// out-of-band job run after the retention period, with the export in hand.
const transition = (name) => asyncHandler(async (req, res, next) => {
  const rule = TRANSITIONS[name];
  const client = await findClientOr404(req.params.clientId);

  if (!rule.from.includes(client.status)) {
    return next(ApiError.badRequest(`A ${client.status} workspace cannot be ${rule.past}`));
  }

  const from = client.status;
  const updated = await prisma.client.update({
    where: { pk: client.pk },
    data: { status: rule.to, [rule.stamp]: new Date() },
  });

  await recordAudit({
    req,
    action: rule.action,
    clientId: client.clientId,
    target: { type: 'Client', id: client.clientId, label: client.companyName },
    meta: { from, to: rule.to, reason: req.body?.reason },
  });

  await getBillingProvider().onTenantStatusChanged({ client: updated, from, to: rule.to });

  res.json({ success: true, tenant: formatClient(updated), message: rule.message });
});

// @desc    Export a tenant's data (offboarding, or a support request)
// @route   GET /api/platform/tenants/:clientId/export
// @access  tenant:manage
//
// The one place a platform operator may see tenant documents, and the reason
// it is allowed: an exit right is worthless if only the tenant can exercise it.
// It is a single audited action producing a whole-tenant archive — not a
// browsing surface, and deliberately not reachable through any tenant endpoint.
const exportTenant = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);

  const collections = await runWithTenant(client.clientId, async () => {
    const entries = await Promise.all(
      tenantModels().map(async ({ name, label, findMany }) => {
        // Credentials and reset tokens are omitted by default on the identity
        // collections (see backend/db/prisma.js), so they are absent here by
        // construction.
        const documents = await findMany();
        return [name, { label, count: documents.length, documents }];
      })
    );
    return Object.fromEntries(entries);
  });

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.TENANT_EXPORTED,
    clientId: client.clientId,
    target: { type: 'Client', id: client.clientId, label: client.companyName },
    meta: {
      counts: Object.fromEntries(Object.entries(collections).map(([name, entry]) => [name, entry.count])),
      reason: req.query.reason,
    },
  });

  res.setHeader('Content-Disposition', `attachment; filename="${client.slug}-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({
    success: true,
    exportedAt: new Date().toISOString(),
    exportedBy: req.auth.email,
    tenant: formatClient(client),
    collections,
  });
});

// @desc    Re-issue the tenant administrator's temporary credentials
// @route   POST /api/platform/tenants/:clientId/administrators/:userId/credentials
// @access  tenant:manage
const reissueCredentials = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);
  const admin = await reissueAdminCredentials({ client, userId: req.params.userId });

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.TENANT_ADMIN_CREDENTIALS_REISSUED,
    clientId: client.clientId,
    target: { type: 'User', id: admin.pk, label: admin.email },
    meta: { delivery: 'email' },
  });

  res.json({ success: true, message: `New credentials have been emailed to ${admin.email}.` });
});

// @desc    Report this tenant's current usage to the billing provider
// @route   POST /api/platform/tenants/:clientId/billing/sync-usage
// @access  tenant:manage
//
// Operator-triggered rather than scheduled: there is no job runner in this
// codebase yet, and a manual sync is enough to prove the seam works end to
// end before one exists.
const syncUsage = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);
  const usage = await usageAgainstLimits(client);
  const result = await getBillingProvider().reportUsage({ client, usage });

  res.json({ success: true, usage, billing: result });
});

module.exports = {
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  suspendTenant: transition('suspend'),
  reactivateTenant: transition('reactivate'),
  terminateTenant: transition('terminate'),
  exportTenant,
  reissueCredentials,
  syncUsage,
  formatClient,
};
