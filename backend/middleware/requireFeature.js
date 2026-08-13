const ApiError = require('../utils/ApiError');
const { settingValue } = require('../config/tenantSettings');

/**
 * Closes a module's API for tenants that have switched it off.
 *
 * The refusal is a 404, not a 403: to a workspace with messaging disabled the
 * endpoint does not exist, and saying "forbidden" would tell a supplier about a
 * feature their workspace does not have.
 *
 * `key` names a boolean entry in config/tenantSettings.js — an unknown key
 * throws there, so a typo fails at boot rather than opening the gate.
 */
const requireFeature = (key) => (req, res, next) => {
  if (!settingValue(req.client, key)) {
    return next(ApiError.notFound('Not found'));
  }
  return next();
};

module.exports = requireFeature;
