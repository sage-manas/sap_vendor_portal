const { z } = require('zod');

// The values Invoice.status carries (prisma/schema.prisma, next to
// DocumentLinkType) plus 'Rejected', which the demo data and the review screen
// use. Not a Prisma enum because several are multi-word.
const INVOICE_STATUSES = ['Submitted', 'Under Review', 'Match Warning', 'Approved', 'Rejected', 'Posted in SAP', 'Cleared'];

const invoiceStatusSchema = z.strictObject({
  status: z.enum(INVOICE_STATUSES),
});

module.exports = { invoiceStatusSchema, INVOICE_STATUSES };
