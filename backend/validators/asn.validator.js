const { z } = require('zod');
const { SAP_FIELDS } = require('../sap/mappings/fields');

const asnItemSchema = z.strictObject({
  line: z.coerce.number().int().positive(),
  shippedQuantity: z.coerce.number().positive(),
  materialCode: z.string().max(SAP_FIELDS.MATNR.max).optional(),
  description: z.string().max(SAP_FIELDS.TXZ01.max).optional(),
  uom: z.string().optional()
});

// An e-way bill number (EBN) is 12 digits. Spaces are how it is often
// printed, so they are stripped rather than refused.
const ewayBillNo = z.string()
  .transform((val) => val.replace(/\s+/g, ''))
  .refine((val) => val === '' || /^\d{12}$/.test(val), { message: 'E-way bill number must be 12 digits' })
  .transform((val) => val || undefined);

const asnCreateSchema = z.strictObject({
  carrierName: z.string().optional(),
  trackingNumber: z.string().optional(),
  vehicleNumber: z.string().optional(),
  // The tax invoice travelling with the goods (ASN design D1/D5). A GST
  // invoice number is at most 16 characters of letters, digits, '-' and '/'
  // (CGST rule 46), which also fits LIKP-LIFEX.
  invoiceReference: z.string().trim()
    .min(1, 'Enter the invoice number')
    .max(16, 'An invoice number is at most 16 characters')
    .regex(/^[A-Za-z0-9/-]+$/, 'An invoice number uses only letters, digits, - and /'),
  invoiceDate: z.string()
    .refine((val) => !isNaN(Date.parse(val)), { message: 'Invalid invoiceDate format' })
    .refine((val) => Date.parse(val) <= Date.now(), { message: 'The invoice date cannot be in the future' }),
  // GST-inclusive total. The e-way bill rule is measured on it.
  invoiceValue: z.coerce.number().positive('Enter the invoice value'),
  ewayBillNo: ewayBillNo.optional(),
  shipDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid shipDate format" }).optional(),
  estimatedDeliveryDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid estimatedDeliveryDate format" }).optional(),
  // One entry per PO line. The open-quantity check runs per entry, so the
  // same line listed twice would pass it twice and ship more than is open.
  items: z.array(asnItemSchema).min(1).refine(
    (items) => new Set(items.map((item) => item.line)).size === items.length,
    { message: 'Each purchase order line can appear only once on a shipment' },
  ),
  documentIds: z.array(z.string().uuid()).max(10).optional()
});

const asnCancelSchema = z.strictObject({
  reason: z.string().trim().min(1, 'Say why the shipment is cancelled').max(500),
});

module.exports = {
  asnCreateSchema,
  asnCancelSchema,
};
