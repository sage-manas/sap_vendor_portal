const { prisma, rawPrisma } = require('../db/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { getSapAdapterForClient } = require('../sap');
const { usageAgainstLimits, against } = require('../utils/usage');
const ApiError = require('../utils/ApiError');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { jobKind } = require('../jobs/kinds');
const { markPending } = require('../jobs/syncState');
const { retryByPk } = require('../jobs/queue');

// The platform health board: for every tenant, is its SAP working, how much of
// its plan is it using, and is anyone actually signing in.
//
// Two things go into a tenant's SAP status, and they answer different
// questions. Traffic — call and failure counts from that tenant's SapLog —
// says whether the integration is *working*. The connection — driver,
// environment, last test, circuit breaker — says whether it is *configured and
// reachable*. A tenant with no traffic and a failing connection must not be
// painted the same as a tenant with no traffic and a healthy one, so the row
// carries both, plus the `{ source, syncedAt }` that says where the numbers
// came from.

const WINDOW_HOURS = 24;
const ACTIVE_USER_DAYS = 30;

const since = (hours) => new Date(Date.now() - hours * 3600 * 1000);

const sapHealthFor = async (clientId) => runWithTenant(clientId, async () => {
  const windowStart = since(WINDOW_HOURS);

  const [total, failed, latest] = await Promise.all([
    prisma.sapLog.count({ where: { timestamp: { gte: windowStart } } }),
    prisma.sapLog.count({ where: { timestamp: { gte: windowStart }, status: 'FAILED' } }),
    prisma.sapLog.findFirst({
      orderBy: { timestamp: 'desc' },
      select: { status: true, timestamp: true, name: true, errorMessage: true },
    }),
  ]);

  // No traffic is not the same as no problem, and the board must not paint an
  // idle tenant green.
  const status = total === 0 ? 'unknown'
    : failed === 0 ? 'healthy'
      : failed / total > 0.25 ? 'failing' : 'degraded';

  return {
    status,
    calls: total,
    failures: failed,
    errorRate: total ? Number((failed / total).toFixed(4)) : null,
    lastCall: latest ? { name: latest.name, status: latest.status, at: latest.timestamp, error: latest.errorMessage } : null,
  };
});

// The configuration half. Reads the tenant's own adapter, so what the board
// shows is exactly what its traffic is running through — including the circuit
// breaker's state, which is the difference between "SAP is broken" and "we
// stopped calling SAP because it was broken".
const sapConnectionFor = async (client) => {
  const environment = client.sapEnvironment || 'sandbox';

  const [connection, adapter] = await Promise.all([
    rawPrisma.sapConnection.findFirst({ where: { clientId: client.clientId, environment } }),
    getSapAdapterForClient(client.clientId),
  ]);

  return {
    driver: adapter.driver,
    environment,
    // A tenant nobody has configured is running the simulator on defaults —
    // true, and worth saying out loud rather than showing as configured.
    configured: Boolean(connection),
    implemented: adapter.implemented,
    lastTest: connection?.lastTest
      ? { ok: connection.lastTest.ok, at: connection.lastTest.at, message: connection.lastTest.message, latencyMs: connection.lastTest.latencyMs }
      : null,
    circuit: adapter.circuit(),
  };
};

const usageFor = async (client) => {
  const [limited, documents, staff, activeStaff] = await runWithTenant(client.clientId, async () => Promise.all([
    usageAgainstLimits(client),
    prisma.document.count({}),
    prisma.user.count({}),
    prisma.user.count({ where: { lastLoginAt: { gte: since(ACTIVE_USER_DAYS * 24) } } }),
  ]));

  return {
    ...limited,
    documents: against(documents, null),
    users: { total: staff, activeLast30Days: activeStaff },
  };
};

// SapJob is deliberately not tenant-scoped (db/tenantExtension.js) — the
// worker claims across every tenant — so this groups by clientId itself
// rather than relying on the extension to do it. `pending`/`running` counts
// with the oldest `pending` runAt is what tells an operator "is anything
// stuck", the way the SAP traffic panel tells them "is anything failing".
const jobsFor = async (clientId) => withoutTenantScope(async () => {
  const [byStatus, oldestPending] = await Promise.all([
    rawPrisma.sapJob.groupBy({ by: ['status'], where: { clientId }, _count: true }),
    rawPrisma.sapJob.findFirst({
      where: { clientId, status: 'pending' },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    }),
  ]);

  const counts = byStatus.reduce((acc, row) => ({ ...acc, [row.status]: row._count }), {});
  return {
    pending: counts.pending || 0,
    running: counts.running || 0,
    failed: counts.failed || 0,
    abandoned: counts.abandoned || 0,
    succeeded: counts.succeeded || 0,
    oldestPendingRunAt: oldestPending?.runAt || null,
  };
});

// @desc    Per-tenant health, usage and activity
// @route   GET /api/platform/health
// @access  platform:health:read
const databaseIsConnected = async () => {
  try {
    await rawPrisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};

const platformHealth = asyncHandler(async (req, res) => {
  const [clients, dbConnected] = await Promise.all([
    prisma.client.findMany({ orderBy: { clientId: 'asc' } }),
    databaseIsConnected(),
  ]);

  const tenants = await Promise.all(clients.map(async (client) => {
    const [traffic, connection, usage, jobs] = await Promise.all([
      sapHealthFor(client.clientId),
      sapConnectionFor(client),
      usageFor(client),
      jobsFor(client.clientId),
    ]);

    return {
      clientId: client.clientId,
      companyName: client.companyName,
      slug: client.slug,
      status: client.status,
      plan: client.plan,
      sap: {
        ...traffic,
        // An open breaker outranks the traffic counts. We stopped calling, so
        // the counts have stopped moving, and a board that read them alone
        // would quietly turn green at the worst possible moment.
        status: connection.circuit.state === 'open' ? 'failing' : traffic.status,
        connection,
        source: connection.driver,
        syncedAt: new Date().toISOString(),
      },
      usage,
      jobs,
    };
  }));

  const operational = tenants.filter((tenant) => ['Trial', 'Active'].includes(tenant.status));

  res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    windowHours: WINDOW_HOURS,
    platform: {
      database: dbConnected ? 'connected' : 'disconnected',
      tenants: {
        total: tenants.length,
        byStatus: tenants.reduce((acc, tenant) => ({ ...acc, [tenant.status]: (acc[tenant.status] || 0) + 1 }), {}),
      },
      sapFailing: operational.filter((tenant) => tenant.sap.status === 'failing').length,
      limitsBreached: operational.filter((tenant) =>
        Object.values(tenant.usage).some((entry) => entry?.breached)).length,
    },
    tenants,
  });
});

// @desc    List SAP jobs, filterable by clientId/kind/status
// @route   GET /api/platform/jobs
// @access  platform:health:read
const listJobs = asyncHandler(async (req, res) => {
  const { clientId, kind, status, page = 1, limit = 50 } = req.query;

  const where = {
    ...(clientId && { clientId }),
    ...(kind && { kind }),
    ...(status && { status }),
  };

  const [jobs, total] = await withoutTenantScope(() => Promise.all([
    rawPrisma.sapJob.findMany({
      where,
      orderBy: { runAt: 'asc' },
      skip: (page - 1) * limit,
      take: Number(limit),
    }),
    rawPrisma.sapJob.count({ where }),
  ]));

  res.json({
    success: true,
    jobs,
    pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / limit) },
  });
});

// @desc    Reset an abandoned/failed job back to pending
// @route   POST /api/platform/jobs/:pk/retry
// @access  tenant:manage
const retryJob = asyncHandler(async (req, res, next) => {
  const { pk } = req.params;

  const job = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { pk } }));
  if (!job) return next(ApiError.notFound('Job not found'));

  // jobKind() throws on a kind this build no longer registers — a job row
  // outliving a deploy that dropped its kind is a data problem worth seeing,
  // not a silent no-op.
  jobKind(job.kind);

  const updated = await retryByPk(pk);

  // Dual identity / sync state (Phase 3): an operator retrying a job is
  // restarting the watch, so the document it watches goes back to `pending`
  // too — failed/orphaned -> pending is a legal transition
  // (config/statuses.js SAP_SYNC_TRANSITIONS). Best-effort: a job kind with
  // no document mapping (or none yet — Phase 4's sweeps) must not block the
  // retry itself.
  await runWithTenant(job.clientId, () => markPending(job.kind, job.args).catch(() => {}));

  await recordAudit({
    action: AUDIT_ACTIONS.JOB_RETRIED,
    req,
    target: { type: 'SapJob', id: pk, label: `${job.kind} (${job.dedupeKey})` },
    meta: { clientId: job.clientId, kind: job.kind, previousStatus: job.status },
    clientId: job.clientId,
  });

  res.json({ success: true, job: updated });
});

module.exports = { platformHealth, listJobs, retryJob };
