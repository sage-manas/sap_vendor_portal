const { z } = require('zod');
const { SAP_FIELDS } = require('../sap/mappings/fields');

const rfqItemSchema = z.object({
  line: z.coerce.number().int().positive(),
  materialCode: z.string().min(1).max(SAP_FIELDS.MATNR.max),
  description: z.string().max(SAP_FIELDS.TXZ01.max).optional(),
  quantity: z.coerce.number().positive(),
  uom: z.string().optional(),
  targetPrice: z.coerce.number().positive().optional(),
  plant: z.string().optional(),
  deliveryDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid deliveryDate format" }).optional()
});

const rfqCreateSchema = z.object({
  description: z.string().min(5).max(200),
  deadlineDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid deadlineDate format" }),
  rfqType: z.enum(['AN', 'AB']).optional(),
  paymentTerms: z.string().optional(),
  deliveryLocation: z.string().optional(),
  items: z.array(rfqItemSchema).min(1),
  invitedVendors: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      status: z.string().optional(),
      rating: z.coerce.number().optional()
    })
  ).optional()
});

const bidSchema = z.object({
  unitPrices: z.record(z.string(), z.coerce.number().positive()),
  gstRate: z.union([z.enum(['5%', '12%', '18%', '28%']), z.string(), z.number()]),
  deliveryLeadTimeDays: z.coerce.number().int().positive(),
  validityDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid validityDate format" }),
  freight: z.coerce.number().min(0).optional(),
  remarks: z.string().optional(),
  uploadedDocs: z.array(z.string()).optional()
});

const reissueRfqSchema = z.object({
  deadlineDate: z.string().refine((val) => !isNaN(Date.parse(val)), { message: "Invalid deadlineDate format" })
});

const quotationPriceUpdateSchema = z.object({
  sapRfqNumber: z.string().min(1),
  items: z.array(
    z.object({
      line: z.coerce.number().int().positive(),
      netPrice: z.coerce.number().positive()
    })
  ).min(1)
});

module.exports = {
  rfqCreateSchema,
  bidSchema,
  reissueRfqSchema,
  quotationPriceUpdateSchema
};
