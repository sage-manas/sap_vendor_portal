const mongoose = require('mongoose');
const Client = require('../models/Client');
const SapLog = require('../models/SapLog');
const asyncHandler = require('../utils/asyncHandler');
const { withoutTenantScope, runWithTenant } = require('../utils/tenantContext');

// The public status page. Unauthenticated, and deliberately anonymous: this
// is what an on-call engineer or a customer checks during an incident, not a
// way to enumerate tenants. It answers "is the platform up" with counts and
// rates — never a company name, a slug, or a clientId.

const START = Date.now();
const WINDOW_HOURS = 1;

// SAP traffic across every operational tenant, summed rather than listed —
// the per-tenant breakdown is what GET /api/platform/health is for, behind
// platform:health:read.
const sapRollup = async (clientIds) => {
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000);

  const totals = await Promise.all(clientIds.map((clientId) => runWithTenant(clientId, async () => {
    const [calls, failures] = await Promise.all([
      SapLog.countDocuments({ timestamp: { $gte: since } }),
      SapLog.countDocuments({ timestamp: { $gte: since }, status: 'FAILED' }),
    ]);
    return { calls, failures };
  })));

  return totals.reduce((acc, entry) => ({
    calls: acc.calls + entry.calls,
    failures: acc.failures + entry.failures,
  }), { calls: 0, failures: 0 });
};

const buildStatus = async () => {
  const dbConnected = mongoose.connection.readyState === 1;

  const operationalClientIds = dbConnected
    ? await withoutTenantScope(async () => {
      const clients = await Client.find({ status: { $in: ['Trial', 'Active'] } }, 'clientId').lean();
      return clients.map((c) => c.clientId);
    })
    : [];

  const sap = dbConnected
    ? await sapRollup(operationalClientIds)
    : { calls: 0, failures: 0 };

  const healthy = dbConnected;

  return {
    status: healthy ? 'operational' : 'outage',
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor((Date.now() - START) / 1000),
    database: dbConnected ? 'connected' : 'disconnected',
    tenants: { operational: operationalClientIds.length },
    sap: {
      windowHours: WINDOW_HOURS,
      calls: sap.calls,
      failures: sap.failures,
      errorRate: sap.calls ? Number((sap.failures / sap.calls).toFixed(4)) : null,
    },
  };
};

const badge = (payload) => (payload.status === 'operational' ? '🟢' : '🔴');

const renderHtml = (payload) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>VendorConnect status</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.35rem 1rem; }
  dt { color: #666; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .status { font-size: 1.5rem; margin-bottom: 1.5rem; }
</style>
</head>
<body>
  <h1>VendorConnect</h1>
  <p class="status">${badge(payload)} ${payload.status}</p>
  <dl>
    <dt>Database</dt><dd>${payload.database}</dd>
    <dt>Operational workspaces</dt><dd>${payload.tenants.operational}</dd>
    <dt>SAP calls (${payload.sap.windowHours}h)</dt><dd>${payload.sap.calls}</dd>
    <dt>SAP failures (${payload.sap.windowHours}h)</dt><dd>${payload.sap.failures}</dd>
    <dt>Uptime</dt><dd>${payload.uptimeSeconds}s</dd>
    <dt>Generated</dt><dd>${payload.generatedAt}</dd>
  </dl>
</body>
</html>`;

// @desc    Public platform status — JSON by default, HTML for a browser
// @route   GET /api/status
// @access  Public
const status = asyncHandler(async (req, res) => {
  const payload = await buildStatus();
  const code = payload.status === 'operational' ? 200 : 503;

  if (req.accepts(['json', 'html']) === 'html') {
    res.status(code).type('html').send(renderHtml(payload));
  } else {
    res.status(code).json(payload);
  }
});

module.exports = { status };
