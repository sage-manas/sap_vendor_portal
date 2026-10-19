const asyncHandler = require('../utils/asyncHandler');
const { withVendorScope, vendorScope } = require('../utils/requestScope');
const { getSapAdapterForClient } = require('../sap');
const { sapTrafficFor, withCircuit } = require('../utils/sapHealth');
const { buildSupplierSummary } = require('../services/supplierSummary.service');

// @desc    Every headline figure the supplier's Overview and Reports screens
//          show, counted and summed in the database.
// @route   GET /api/dashboard/summary
// @access  Private
//
// This answered four numbers until issue #280. The screens computed the rest
// in the browser from one page of each list endpoint, so a supplier with
// eleven documents of any kind read totals, charts and exports that covered
// ten of them. services/supplierSummary.service.js is where each figure is
// defined now; the client renders what it answers rather than aggregating.
const getDashboardSummary = asyncHandler(async (req, res, next) => {
  // Suppliers see their own numbers; tenant staff see the whole tenant.
  res.json(await buildSupplierSummary({
    vendorId: vendorScope(req),
    where: withVendorScope(req),
  }));
});

const SAP_STATUS_WINDOW_HOURS = 24;
const SAP_STATUS_CACHE_MS = 30 * 1000;

// Every open tab polls this, so the workspace-wide half is held briefly per
// tenant. Only the coarse state is cached — never anything vendor-scoped.
const workspaceSapCache = new Map();

const workspaceSapState = async (clientId) => {
  const hit = workspaceSapCache.get(clientId);
  if (hit && Date.now() - hit.at < SAP_STATUS_CACHE_MS) return hit.value;

  const [traffic, adapter] = await Promise.all([
    sapTrafficFor(clientId, SAP_STATUS_WINDOW_HOURS),
    getSapAdapterForClient(clientId),
  ]);
  // A tenant on the built-in simulator is not "connected to SAP", however
  // healthy its simulated traffic looks.
  const simulated = adapter.driver === 'mock';
  const value = {
    status: simulated ? 'simulated' : withCircuit(traffic.status, adapter.circuit()),
    environment: adapter.environment,
    traffic,
  };
  workspaceSapCache.set(clientId, { at: Date.now(), value });
  return value;
};

// @desc    This workspace's SAP connection, as the app's top bar shows it
// @route   GET /api/dashboard/sap-status
// @access  dashboard:read (every tenant role and suppliers)
//
// The tenant's own row of the platform health board (utils/sapHealth.js), cut
// down to what anyone in the workspace may see. The state is the workspace's —
// a supplier needs to know whether their buyer's SAP is answering — but call
// counts and the last-sync time are the supplier's own (as GET /logs scopes
// SapLog), so polling this reveals nothing about other suppliers' activity.
// No call names or SAP error text.
const getSapStatus = asyncHandler(async (req, res) => {
  const workspace = await workspaceSapState(req.clientId);
  const traffic = req.scopeVendorId
    ? await sapTrafficFor(req.clientId, SAP_STATUS_WINDOW_HOURS, { vendorId: req.scopeVendorId })
    : workspace.traffic;

  res.json({
    status: workspace.status,
    environment: workspace.environment,
    lastSyncAt: traffic.lastSuccessAt,
    windowHours: SAP_STATUS_WINDOW_HOURS,
    calls: traffic.calls,
    failures: traffic.failures,
    scope: req.scopeVendorId ? 'supplier' : 'workspace',
    checkedAt: new Date().toISOString(),
  });
});

// Tests reset the cache between cases.
const resetSapStatusCache = () => workspaceSapCache.clear();

module.exports = {
  getDashboardSummary,
  getSapStatus,
  resetSapStatusCache,
};
