const ApiError = require('../utils/ApiError');
const { isSupplier } = require('../utils/requestScope');
const { VENDOR_TRANSACTING, VENDOR_AWAITING_DECISION } = require('../config/statuses');

/**
 * The transacting modules belong to suppliers their buyer has approved.
 *
 * Holding `rfq:bid` or `asn:create` is a fact about the *role*; whether the
 * buyer has accepted this supplier is a fact about the *record*, and
 * permissions cannot express it — a Draft account holds the whole supplier
 * permission set from the moment it exists. This is the second gate, and it is
 * the reason the portal can hide the module tabs without that being the only
 * thing stopping an unapproved supplier from bidding.
 *
 * Approval, not submission, opens it (config/statuses.js VENDOR_TRANSACTING
 * says why). Anything else is refused, an unrecognised status included — the
 * gate fails closed. The two refusals differ only in what they tell the
 * supplier: one still owes us a registration, the other is waiting on us.
 *
 * Scoped deliberately narrowly:
 *   - tenant staff pass through untouched (they are not onboarding),
 *   - so do /vendors (the registration form itself), /uploads (the compliance
 *     documents that form collects) and /dashboard (the shell the registration
 *     tab lives in — which withholds document figures from an unapproved
 *     supplier itself; see controllers/dashboard.controller.js).
 */
const requireOnboarded = (req, res, next) => {
  if (!isSupplier(req)) return next();

  const status = req.vendor?.status;
  if (VENDOR_TRANSACTING.includes(status)) return next();

  if (VENDOR_AWAITING_DECISION.includes(status)) {
    return next(ApiError.forbidden(
      'Your registration is with your buyer for approval. This part of the portal opens once they approve it.',
      { reason: 'registration_awaiting_approval' },
    ));
  }

  return next(ApiError.forbidden(
    'Complete and submit your registration before using this part of the portal',
    { reason: 'registration_incomplete' },
  ));
};

module.exports = requireOnboarded;
