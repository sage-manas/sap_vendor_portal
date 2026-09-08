const ApiError = require('../utils/ApiError');
const { isSupplier } = require('../utils/requestScope');
const { VENDOR_PRE_SUBMISSION } = require('../config/statuses');

/**
 * The transacting modules belong to suppliers who have finished onboarding.
 *
 * Holding `rfq:bid` or `invoice:submit` is a fact about the *role*; whether the
 * supplier has actually registered is a fact about the *record*, and permissions
 * cannot express it — a Draft account holds the whole supplier permission set
 * from the moment it exists. This is the second gate, and it is the reason the
 * portal can hide the module tabs without that being the only thing stopping a
 * half-registered supplier from bidding.
 *
 * Scoped deliberately narrowly:
 *   - tenant staff pass through untouched (they are not onboarding),
 *   - so do /vendors (the registration form itself), /uploads (the compliance
 *     documents that form collects) and /dashboard (the shell the registration
 *     tab lives in).
 *
 * A supplier awaiting a decision is let through: they have done their part, and
 * a bid they place still cannot reach SAP without an approved vendor master.
 */
const requireOnboarded = (req, res, next) => {
  if (!isSupplier(req)) return next();

  const status = req.vendor?.status;
  if (VENDOR_PRE_SUBMISSION.includes(status)) {
    return next(ApiError.forbidden(
      'Complete and submit your registration before using this part of the portal',
      { reason: 'registration_incomplete' },
    ));
  }

  return next();
};

module.exports = requireOnboarded;
