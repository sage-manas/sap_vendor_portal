const { z } = require('zod');

// The values Invoice.status carries. Not a Prisma enum because several are
// multi-word — config/statuses.js is the registry instead, shared with the
// overview's counts and the supplier's ageing buckets so that "not yet paid"
// means one thing across the app (issue #283).
const { INVOICE_STATUSES } = require('../config/statuses');

const invoiceStatusSchema = z.strictObject({
  status: z.enum(INVOICE_STATUSES),
});

module.exports = { invoiceStatusSchema, INVOICE_STATUSES };
