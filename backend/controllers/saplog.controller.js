const SapLog = require('../models/SapLog');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const { vendorScope } = require('../utils/requestScope');

// @desc    Get SAP log history
// @route   GET /api/logs
// @access  Private
const listSapLogs = asyncHandler(async (req, res, next) => {
  const vendorId = vendorScope(req);
  const { type, status, all } = req.query;

  const query = {};
  if (all !== 'true') {
    query.vendorId = vendorId;
  }

  if (type) {
    query.type = type;
  }

  if (status) {
    query.status = status;
  }

  const logs = await SapLog.find(query)
    .sort({ timestamp: -1 })
    .limit(100);

  res.json(logs);
});

module.exports = {
  listSapLogs
};
