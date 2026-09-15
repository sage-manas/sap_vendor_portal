const { z } = require('zod');
const { PLAN_TYPES, INVOICING_RULES, FREQUENCIES } = require('../services/invoicePlan.service');

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid date' });

const milestoneSchema = z.object({
  settlementDate: isoDate,
  description: z.string().max(200).optional(),
  // A milestone states its share either way round — a percentage of the line or
  // a flat amount. The service derives whichever is missing and rejects both
  // being absent, so neither is required here.
  percentage: z.coerce.number().gt(0).max(100).optional(),
  amount: z.coerce.number().gt(0).optional(),
  blocked: z.boolean().optional(),
});

// One schema for both plan types, narrowed by superRefine rather than a
// discriminated union: the two shapes share more than they differ, and the
// error a buyer needs ("a periodic plan needs a frequency") reads better than
// "no union member matched".
const invoicePlanSchema = z.object({
  type: z.enum(PLAN_TYPES),
  reference: z.string().max(200).optional(),
  currency: z.string().length(3).optional(),
  planNumber: z.string().max(20).optional(),

  // Periodic
  startDate: isoDate.optional(),
  endDate: isoDate.optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  invoicingRule: z.enum(INVOICING_RULES).optional(),
  periodicAmount: z.coerce.number().gt(0).optional(),

  // Partial
  milestones: z.array(milestoneSchema).min(1).max(120).optional(),
}).superRefine((plan, ctx) => {
  if (plan.type === 'Periodic') {
    for (const field of ['startDate', 'endDate', 'frequency']) {
      if (!plan[field]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `A periodic invoicing plan needs a ${field === 'frequency' ? 'frequency' : field.replace('Date', ' date')}` });
      }
    }
    if (plan.milestones) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['milestones'], message: 'Instalments belong to a partial invoicing plan, not a periodic one' });
    }
  } else {
    if (!plan.milestones?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['milestones'], message: 'A partial invoicing plan needs at least one instalment' });
    }
    if (plan.frequency || plan.periodicAmount) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['frequency'], message: 'A frequency and a per-period amount belong to a periodic invoicing plan, not a partial one' });
    }
  }
});

// FPLT-FAKSP, on its own: withholding one date is not a change to the schedule.
const invoicePlanLineBlockSchema = z.object({ blocked: z.boolean() });

module.exports = { invoicePlanSchema, invoicePlanLineBlockSchema };
