const { z } = require('zod');
const { GSTIN_SHAPE, GSTIN_CHECK_MESSAGE, isGstinShape, hasValidCheckCharacter } = require('../utils/gstin');

// For a write route that takes no body at all (an approval, a retry, a cancel).
// A schema is still put in front of it: the route then refuses a body it would
// have ignored today and might read tomorrow, and the route-table test
// (tests/write-validation-route-table.test.js) can hold every write route to
// the same rule without a list of exceptions.
const noBody = z.strictObject({});

// A GSTIN, wherever one is written: a supplier signing up, a supplier's
// profile, a tenant's own registration. One legal identifier, one rule. The
// check-character refusal is reported only for a GSTIN of the right shape, so
// a malformed one gets the format message alone (utils/gstin.js).
const gstinField = z.string()
  .regex(GSTIN_SHAPE, { message: 'Invalid GSTIN format' })
  .refine((value) => !isGstinShape(value) || hasValidCheckCharacter(value), { message: GSTIN_CHECK_MESSAGE });

module.exports = { noBody, gstinField };
