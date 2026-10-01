const { z } = require('zod');

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid date' });
const amount = z.coerce.number().min(0);

const settledInvoiceSchema = z.strictObject({
  poId: z.string().min(1),
  invoiceId: z.string().min(1),
  invoiceNumber: z.string().optional(),
  sapMiroDoc: z.string().optional(),
  grossAmount: amount,
  tdsDeducted: amount.optional(),
  netAmount: amount,
});

// createPayment used to spread whatever else the body carried straight into
// prisma.payment.create, so a caller could set sapSyncState, sapDocNumber, the
// tenant or the vendor. Only the remittance's own header columns are named
// here; the totals are computed from the items, and vendorId, clientId and the
// sync state are never the caller's to set.
const paymentHeaderShape = {
  id: z.string().min(1).max(50).optional(),
  // Which supplier a tenant-staff caller is paying; a supplier's own request
  // is pinned to their own id whatever this says (utils/requestScope.js).
  vendorId: z.string().min(1).optional(),
  paymentDate: isoDate,
  utrCode: z.string().min(1).max(50),
  paymentMethod: z.enum(['NEFT', 'RTGS', 'IMPS']).optional(),
  sapPaymentDoc: z.string().optional(),
  bankName: z.string().optional(),
  runId: z.string().optional(),
  fiscalYear: z.coerce.number().int().optional(),
  quarter: z.string().optional(),
  tdsSection: z.string().optional(),
  deducteePan: z.string().optional(),
  deductorTan: z.string().optional(),
};

// One settled invoice may be given flat, as before, or several as `items`.
const createPaymentSchema = z.strictObject({
  ...paymentHeaderShape,
  items: z.array(settledInvoiceSchema).min(1).optional(),
  ...settledInvoiceSchema.shape,
  poId: z.string().min(1).optional(),
  invoiceId: z.string().min(1).optional(),
  grossAmount: amount.optional(),
  netAmount: amount.optional(),
});

module.exports = { createPaymentSchema };
