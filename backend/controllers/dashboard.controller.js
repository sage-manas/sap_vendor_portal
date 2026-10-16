const { prisma } = require('../db/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { withVendorScope } = require('../utils/requestScope');
const { toNumber } = require('../utils/money');
const { getSapAdapterForClient } = require('../sap');
const { sapTrafficFor, withCircuit } = require('../utils/sapHealth');

// @desc    Get dashboard summary statistics
// @route   GET /api/dashboard/summary
// @access  Private
const getDashboardSummary = asyncHandler(async (req, res, next) => {
  // Suppliers see their own numbers; tenant staff see the whole tenant.
  const where = withVendorScope(req);

  const [openPOs, pendingGRNs, invoices, payments] = await Promise.all([
    prisma.purchaseOrder.count({ where: { ...where, status: { in: ['Open', 'Acknowledged'] } } }),
    prisma.gRN.count({ where: { ...where, invoiceSubmitted: false } }),
    prisma.invoice.findMany({ where }),
    prisma.payment.findMany({ where }),
  ]);

  // netAmount/grossAmount are Decimal-typed columns — see utils/money.js for
  // why `sum + p.netAmount` on a raw one would silently concatenate strings
  // instead of summing.
  const totalPaymentsAmount = payments.reduce(
    (sum, p) => sum + (toNumber(p.netAmount) || toNumber(p.grossAmount) || 0), 0,
  );

  res.json({
    openPOCount: openPOs,
    pendingGRNsCount: pendingGRNs,
    invoiceCount: invoices.length,
    totalPaymentsAmount,
    timestamp: new Date().toISOString()
  });
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
