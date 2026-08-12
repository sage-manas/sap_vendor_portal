const mongoose = require('mongoose');
const Client = require('../models/Client');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const RFQ = require('../models/RFQ');
const SapLog = require('../models/SapLog');
const DocumentModel = require('../models/Document');
const asyncHandler = require('../utils/asyncHandler');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

// The platform health board: for every tenant, is its SAP working, how much of
// its plan is it using, and is anyone actually signing in.
//
// SAP status is derived from each tenant's SapLog today. Phase 4 replaces that
// derivation with the real thing — `SapConnection.lastTestResult` plus the
// scheduled health ping — behind the same response shape, which is why every
// row carries `{ source, syncedAt }`: the console can already say honestly
// where a number came from.

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
    // Phase 4 flips this to 'sap' for tenants on a real driver.
    source: 'mock',
    syncedAt: new Date().toISOString(),
  };
});

const usageFor = async (client) => runWithTenant(client.clientId, async () => {
  const [vendors, rfqsThisMonth, documents, staff, activeStaff] = await Promise.all([
    Vendor.countDocuments({}),
    RFQ.countDocuments({ createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }),
    DocumentModel.countDocuments({}),
    User.countDocuments({}),
    User.countDocuments({ lastLoginAt: { $gte: since(ACTIVE_USER_DAYS * 24) } }),
  ]);

  const against = (used, limit) => ({
    used,
    limit: limit ?? null,
    // null rather than 0 when there is no limit: "unlimited" and "nothing left"
    // must not render the same.
    ratio: limit ? Number((used / limit).toFixed(3)) : null,
    breached: Boolean(limit && used > limit),
  });

  return {
    vendors: against(vendors, client.limits?.vendors),
    rfqsThisMonth: against(rfqsThisMonth, client.limits?.rfqsPerMonth),
    documents: against(documents, null),
    users: { total: staff, activeLast30Days: activeStaff },
  };
});

// @desc    Per-tenant health, usage and activity
// @route   GET /api/platform/health
// @access  platform:health:read
const platformHealth = asyncHandler(async (req, res) => {
  const clients = await withoutTenantScope(() => Client.find({}).sort({ clientId: 1 }));

  const tenants = await Promise.all(clients.map(async (client) => ({
    clientId: client.clientId,
    companyName: client.companyName,
    slug: client.slug,
    status: client.status,
    plan: client.plan,
    sap: await sapHealthFor(client.clientId),
    usage: await usageFor(client),
  })));

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
