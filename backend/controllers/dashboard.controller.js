const { prisma } = require('../db/prisma');
const asyncHandler = require('../utils/asyncHandler');
const { withVendorScope } = require('../utils/requestScope');
const { toNumber } = require('../utils/money');

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

module.exports = {
  getDashboardSummary
};
