const { z } = require('zod');

// Creating an asset purchase order in SAP (ADR-0042). This is the only place
// the portal originates an SAP document, so the validation here is deliberately
// stricter than the portal's usual "accept it and let SAP complain" posture:
// a rejected request costs a round trip, while an accepted-but-wrong one
// creates a real capex document in the customer's books that this application
// has no way to reverse.

// ANLN1 is CHAR(12) in SAP and the sandbox sends it zero-padded
// ("000000000701"). Accepted unpadded too — the driver sends what it is given
// and SAP's own conversion exit handles the padding — but never blank, and
// never anything but digits, which is the shape that would silently create the
// order against a different asset.
const assetNumber = z.string()
  .trim()
  .min(1, 'An asset number is required')
  .max(12, 'An asset number is at most 12 characters')
  .regex(/^\d+$/, 'An asset number is digits only (ANLN1)');

// ANLN2, the asset sub-number. '0000' is the main asset rather than "none", so
// it is defaulted rather than left blank — but it is still an explicit value in
// the payload, not an empty string SAP has to interpret.
const assetSubNumber = z.string()
  .trim()
  .max(4, 'An asset sub-number is at most 4 characters')
  .regex(/^\d+$/, 'An asset sub-number is digits only (ANLN2)')
  .default('0000');

const assetPoItemSchema = z.object({
  // SHORT_TEXT / TXZ01 — SAP truncates at 40 characters, so this refuses rather
  // than letting a description be silently cut in half in the customer's books.
  description: z.string().trim().min(1, 'Each line needs a description').max(40, 'A line description is at most 40 characters (SAP TXZ01)'),
  plant: z.string().trim().min(1, 'Each line needs a plant').max(4),
  storageLocation: z.string().trim().max(4).optional(),
  materialGroup: z.string().trim().max(9).optional(),
  quantity: z.coerce.number().gt(0, 'Quantity must be greater than zero'),
  uom: z.string().trim().min(1).max(3).default('EA'),
  unitPrice: z.coerce.number().gt(0, 'Unit price must be greater than zero'),
  priceUnit: z.coerce.number().int().gt(0).default(1),
  taxCode: z.string().trim().max(2).optional(),
  assetNumber,
  assetSubNumber,
});

const assetPoSchema = z.object({
  vendorId: z.string().trim().min(1, 'A vendor is required'),

  // Organisational scope. No defaults anywhere here — issue #62's whole point
  // is that a value on a purchase order means a real one was supplied, never
  // that '1000' was assumed. An asset PO has no awarding RFQ to carry these
  // from, so the caller states them.
  companyCode: z.string().trim().min(1, 'A company code is required').max(4),
  purchasingOrg: z.string().trim().min(1, 'A purchasing organisation is required').max(4),
  purchasingGroup: z.string().trim().min(1, 'A purchasing group is required').max(3),

  docType: z.string().trim().max(4).optional(),
  paymentTerms: z.string().trim().max(4).optional(),
  currency: z.string().trim().length(3).default('INR'),
  docDate: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid document date' }).optional(),
  deliveryAddress: z.string().trim().max(500).optional(),

  items: z.array(assetPoItemSchema).min(1, 'An asset purchase order needs at least one line').max(99),
});

module.exports = { assetPoSchema };
