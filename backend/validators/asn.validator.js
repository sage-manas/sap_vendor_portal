const { z } = require('zod');
const { SAP_FIELDS } = require('../sap/mappings/fields');

const asnItemSchema = z.strictObject({
  // The order this line is for. Optional on POST /pos/:id/asn, where the URL
  // names it; required on POST /asns, which can carry several orders.
  poId: z.string().min(1).max(40).optional(),
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

// Spaces and hyphens are how these are printed; they are stripped, and
// letters upper-cased, before the format is checked and before storing.
const compact = (val) => val.replace(/[\s-]+/g, '').toUpperCase();

// An Indian registration: state + RTO + series + number (HR55AB1234), the
// Bharat series (22BH1234AB), or a temporary registration (T0526MH1234AB).
const VEHICLE_NUMBER = /^(?:[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}|\d{2}BH\d{4}[A-Z]{1,2}|T\d{4}[A-Z]{2}\d{4}[A-Z]{1,2})$/;
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const MOBILE = /^(?:\+?91)?[6-9]\d{9}$/;
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const isoDate = (field) => z.string().refine((val) => !isNaN(Date.parse(val)), { message: `Invalid ${field} format` });
// Calendar day in UTC, so '2026-11-21' and '2026-11-21T00:00:00Z' compare equal.
const dayOf = (val) => new Date(val).toISOString().slice(0, 10);

const asnCreateBase = z.strictObject({
  // Transporter, and how the consignment is identified on the road: an LR /
  // docket number, a vehicle number, or both (the cross-field rule below). A
  // courier consignment has a docket and no vehicle; the supplier's own truck
  // has a vehicle and no LR.
  carrierName: z.string().trim().max(100).optional(),
  trackingNumber: z.string().trim().max(35).optional(),
  vehicleNumber: z.string().transform(compact)
    .refine((val) => val === '' || VEHICLE_NUMBER.test(val), { message: 'Check the vehicle number (for example HR55AB1234 or 22BH1234AB)' })
    .transform((val) => val || undefined)
    .optional(),
  vehicleType: z.string().trim().max(40).optional(),
  driverMobile: z.string().transform((val) => val.replace(/[\s-]+/g, ''))
    .refine((val) => val === '' || MOBILE.test(val), { message: 'Enter a 10-digit Indian mobile number' })
    .transform((val) => val || undefined)
    .optional(),
  transporterGstin: z.string().transform(compact)
    .refine((val) => val === '' || GSTIN.test(val), { message: 'Check the transporter GSTIN' })
    .transform((val) => val || undefined)
    .optional(),
  arrivalTime: z.string().refine((val) => val === '' || HH_MM.test(val), { message: 'Use a 24-hour time, for example 10:30' })
    .transform((val) => val || undefined)
    .optional(),
  packages: z.coerce.number().int().positive().max(100000).optional(),
  grossWeightKg: z.coerce.number().positive().max(1e9).optional(),
  taxableValue: z.coerce.number().positive().optional(),
  ewayBillDate: isoDate('ewayBillDate').optional(),
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
    (items) => new Set(items.map((item) => `${item.poId || ''}:${item.line}`)).size === items.length,
    { message: 'Each purchase order line can appear only once on a shipment' },
  ),
  documentIds: z.array(z.string().uuid()).max(10).optional()
});

// The rules that read more than one field (agreed for screen V4). Each issue
// names the field to show it against.
const shipmentRules = (body, ctx) => {
  const issue = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  const ship = body.shipDate || new Date().toISOString();

  if (!body.carrierName) issue('carrierName', 'Enter the transporter');
  if (!body.trackingNumber && !body.vehicleNumber) {
    issue('trackingNumber', 'Enter the LR / docket number or the vehicle number');
  }
  if (body.invoiceDate && dayOf(body.invoiceDate) > dayOf(ship)) {
    issue('invoiceDate', 'The invoice date cannot be after the dispatch date');
  }
  if (body.estimatedDeliveryDate && dayOf(body.estimatedDeliveryDate) < dayOf(ship)) {
    issue('estimatedDeliveryDate', 'Expected arrival cannot be before dispatch');
  }
  if (body.ewayBillNo && !body.ewayBillDate) issue('ewayBillDate', 'Enter the e-way bill date');
  if (body.ewayBillDate && dayOf(body.ewayBillDate) > dayOf(ship)) {
    issue('ewayBillDate', 'The e-way bill date cannot be after the dispatch date');
  }
  if (body.taxableValue != null && body.invoiceValue != null && body.taxableValue > body.invoiceValue) {
    issue('taxableValue', 'The taxable value cannot be more than the invoice total');
  }
};

const asnCreateSchema = asnCreateBase.superRefine(shipmentRules);

const asnCancelSchema = z.strictObject({
  reason: z.string().trim().min(1, 'Say why the shipment is cancelled').max(500),
});

// A draft keeps what the supplier typed, half-finished or not, so it checks
// shape and size only — no formats, no required fields. The same keys as
// asnCreateSchema and no others, so a draft can only ever hold a form that
// submit would read; every real rule runs on submit.
const text = (max) => z.string().max(max).optional();
const asnDraftPayloadSchema = z.strictObject({
  carrierName: text(100),
  trackingNumber: text(100),
  vehicleNumber: text(30),
  invoiceReference: text(30),
  invoiceDate: text(30),
  invoiceValue: z.union([z.number(), z.string().max(30)]).optional(),
  ewayBillNo: text(30),
  ewayBillDate: text(30),
  taxableValue: z.union([z.number(), z.string().max(30)]).optional(),
  arrivalTime: text(10),
  vehicleType: text(40),
  driverMobile: text(20),
  transporterGstin: text(20),
  packages: z.union([z.number(), z.string().max(10)]).optional(),
  grossWeightKg: z.union([z.number(), z.string().max(20)]).optional(),
  shipDate: text(30),
  estimatedDeliveryDate: text(30),
  items: z.array(z.strictObject({
    poId: z.string().max(40).optional(),
    line: z.coerce.number().int().positive(),
    shippedQuantity: z.union([z.number(), z.string().max(30)]).optional(),
  })).max(500).optional(),
  documentIds: z.array(z.string().uuid()).max(10).optional(),
  // The files the form shows, by slot, so a resumed draft shows them again.
  // Submit turns these into documentIds.
  attachments: z.strictObject(Object.fromEntries(
    ['packingList', 'invoiceCopy', 'transportDoc', 'ewayBill', 'certificate'].map((slot) => [slot, z.strictObject({
      documentId: z.string().uuid(),
      originalName: z.string().max(255).optional(),
      size: z.number().nonnegative().optional(),
    }).nullable().optional()]),
  )).optional(),
});

const asnDraftSchema = z.strictObject({
  poId: z.string().min(1).max(40).nullable().optional(),
  step: z.coerce.number().int().min(1).max(4).optional(),
  payload: asnDraftPayloadSchema.optional(),
});

// POST /asns: no order in the URL, so every line names its own.
const asnCreateMultiSchema = asnCreateBase.extend({
  items: asnCreateBase.shape.items.refine(
    (items) => items.every((item) => item.poId),
    { message: 'Say which purchase order each line is for' },
  ),
}).superRefine(shipmentRules);

module.exports = {
  asnCreateSchema,
  asnCreateMultiSchema,
  asnCancelSchema,
  asnDraftSchema,
};
