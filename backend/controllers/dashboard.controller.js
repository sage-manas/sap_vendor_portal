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

// @desc    This workspace's SAP connection, as the app's top bar shows it
// @route   GET /api/dashboard/sap-status
// @access  dashboard:read (every tenant role and suppliers)
//
// The tenant's own row of the platform health board (utils/sapHealth.js), cut
// down to what anyone in the workspace may see: whether SAP is answering and
// when it last did. No call names or SAP error text — suppliers read this too.
const getSapStatus = asyncHandler(async (req, res) => {
  const [client, traffic, adapter] = await Promise.all([
    prisma.client.findUnique({ where: { clientId: req.clientId }, select: { sapEnvironment: true } }),
    sapTrafficFor(req.clientId, SAP_STATUS_WINDOW_HOURS),
    getSapAdapterForClient(req.clientId),
  ]);

  res.json({
    status: withCircuit(traffic.status, adapter.circuit()),
    environment: client?.sapEnvironment || 'sandbox',
    lastSyncAt: traffic.lastSuccessAt,
    windowHours: SAP_STATUS_WINDOW_HOURS,
    calls: traffic.calls,
    failures: traffic.failures,
    checkedAt: new Date().toISOString(),
  });
});

module.exports = {
  getDashboardSummary,
  getSapStatus,
};
