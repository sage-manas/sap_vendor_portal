const mongoose = require('mongoose');
const Client = require('../models/Client');
const User = require('../models/User');
const SapLog = require('../models/SapLog');
const DocumentModel = require('../models/Document');
const SapConnection = require('../models/SapConnection');
const asyncHandler = require('../utils/asyncHandler');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { getSapAdapterForClient } = require('../sap');
const { usageAgainstLimits, against } = require('../utils/usage');

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
    SapLog.countDocuments({ timestamp: { $gte: windowStart } }),
    SapLog.countDocuments({ timestamp: { $gte: windowStart }, status: 'FAILED' }),
    SapLog.findOne({}).sort({ timestamp: -1 }).select('status timestamp name errorMessage'),
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
    withoutTenantScope(() => SapConnection.findOne({ clientId: client.clientId, environment })),
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
    DocumentModel.countDocuments({}),
    User.countDocuments({}),
    User.countDocuments({ lastLoginAt: { $gte: since(ACTIVE_USER_DAYS * 24) } }),
  ]));

  return {
    ...limited,
    documents: against(documents, null),
    users: { total: staff, activeLast30Days: activeStaff },
  };
};

// @desc    Per-tenant health, usage and activity
// @route   GET /api/platform/health
// @access  platform:health:read
const platformHealth = asyncHandler(async (req, res) => {
  const clients = await withoutTenantScope(() => Client.find({}).sort({ clientId: 1 }));

  const tenants = await Promise.all(clients.map(async (client) => {
    const [traffic, connection, usage] = await Promise.all([
      sapHealthFor(client.clientId),
      sapConnectionFor(client),
      usageFor(client),
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
    };
  }));

  const operational = tenants.filter((tenant) => ['Trial', 'Active'].includes(tenant.status));

  res.json({
    success: true,
    generatedAt: new Date().toISOString(),
    windowHours: WINDOW_HOURS,
    platform: {
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
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

module.exports = { platformHealth };
