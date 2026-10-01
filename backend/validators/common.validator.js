const { z } = require('zod');

// For a write route that takes no body at all (an approval, a retry, a cancel).
// A schema is still put in front of it: the route then refuses a body it would
// have ignored today and might read tomorrow, and the route-table test
// (tests/write-validation-route-table.test.js) can hold every write route to
// the same rule without a list of exceptions.
const noBody = z.strictObject({});

module.exports = { noBody };
