const { prisma } = require('../db/prisma');
const asyncHandler = require('../utils/asyncHandler');

const { vendorScope, isSupplier } = require('../utils/requestScope');

// @desc    Get SAP log history
// @route   GET /api/logs
// @access  Private
const listSapLogs = asyncHandler(async (req, res, next) => {
  const vendorId = vendorScope(req);
  const { type, status, all } = req.query;

  // `?all=true` is a staff affordance and nothing else. Honouring it for a
  // supplier would hand them the whole tenant's log, and VENDOR_CREATE payloads
  // carry other suppliers' bank account numbers and IFSC codes.
  //
  // Staff, conversely, are unscoped unless they name a supplier: the older
  // `all !== 'true'` alone pinned their query to `vendorId: null` and answered
  // an empty list.
  const where = {};
  if (isSupplier(req) || (vendorId && all !== 'true')) {
    where.vendorId = vendorId;
  }

  if (type) {
    where.type = type;
  }

  if (status) {
    where.status = status;
  }

  const logs = await prisma.sapLog.findMany({ where, orderBy: { timestamp: 'desc' }, take: 100 });

  res.json(logs);
});

module.exports = {
  listSapLogs
};
