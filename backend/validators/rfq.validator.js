const { z } = require('zod');
const { SAP_FIELDS } = require('../sap/mappings/fields');

const rfqItemSchema = z.strictObject({
  line: z.coerce.number().int().positive(),
  materialCode: z.string().min(1).max(SAP_FIELDS.MATNR.max),
  description: z.string().max(SAP_FIELDS.TXZ01.max).optional(),
  quantity: z.coerce.number().positive(),
  uom: z.string().optional(),
  targetPrice: z.coerce.number().positive().optional(),
  plant: z.string().optional(),
  deliveryDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid deliveryDate format" }).optional()
});

const rfqCreateSchema = z.strictObject({
  description: z.string().min(5).max(200),
  deadlineDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid deadlineDate format" }),
  rfqType: z.enum(['AN', 'AB']).optional(),
  paymentTerms: z.string().optional(),
  deliveryLocation: z.string().optional(),
  // Organisational scope (issue #125). Optional, with no default anywhere
  // here -- the same rule validators/assetPo.validator.js already states for
  // a purchase order: "a value on a purchase order means a real one was
  // supplied, never that '1000' was assumed". A buyer states these, or the
  // workspace's `sourcing` setting supplies them, or the RFQ genuinely has
  // none and reads as unset.
  //
  // The widths are SAP's own: EKORG and BUKRS are CHAR(4), EKGRP CHAR(3).
  // Stated here rather than through sap/mappings/fields.js because that
  // registry declares only the six fields a form reads a maxLength from
  // (SAP_FIELD_KEYS), and these three are not among them.
  purchasingOrg: z.string().max(4).optional(),
  companyCode: z.string().max(4).optional(),
  purchasingGroup: z.string().max(3).optional(),
  items: z.array(rfqItemSchema).min(1),
  invitedVendors: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().optional(),
      status: z.string().optional(),
      rating: z.coerce.number().optional()
    })
  ).optional()
});

const bidSchema = z.strictObject({
  unitPrices: z.record(z.string(), z.coerce.number().positive()),
  gstRate: z.union([z.enum(['5%', '12%', '18%', '28%']), z.string(), z.number()]),
  deliveryLeadTimeDays: z.coerce.number().int().positive(),
  validityDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid validityDate format" }),
  freight: z.coerce.number().min(0).optional(),
  remarks: z.string().optional(),
  uploadedDocs: z.array(z.string()).optional()
});

const reissueRfqSchema = z.strictObject({
  deadlineDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid deadlineDate format" })
});

const quotationPriceUpdateSchema = z.strictObject({
  sapRfqNumber: z.string().min(1),
  items: z.array(
    z.strictObject({
      line: z.coerce.number().int().positive(),
      netPrice: z.coerce.number().positive()
    })
  ).min(1)
});

const awardSchema = z.strictObject({
  vendorId: z.string().min(1, { message: 'Winner vendorId is required' })
});

module.exports = {
  awardSchema,
  rfqCreateSchema,
  bidSchema,
  reissueRfqSchema,
  quotationPriceUpdateSchema
};
