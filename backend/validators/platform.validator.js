const { z } = require('zod');
const { PLATFORM_ROLES } = require('../config/roles');
const { DRIVER_KEYS } = require('../sap/drivers');
const { ENVIRONMENTS } = require('../db/sapConnectionHelpers');

// Request shapes for the platform console. Roles come from the registry, so a
// seventh role is still a one-file change.

const slugField = z.string()
  .min(3).max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'Workspace address may contain lowercase letters, digits and hyphens, and cannot start or end with a hyphen',
  });

const limitsSchema = z.object({
  vendors: z.number().int().positive().optional(),
  rfqsPerMonth: z.number().int().positive().optional(),
  storageMb: z.number().int().positive().optional(),
}).strict();

const brandingSchema = z.object({
  logo: z.string().max(500).optional(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i, { message: 'Primary colour must be a hex value like #059669' }).optional(),
}).strict();

const createTenantSchema = z.object({
  companyName: z.string().min(2).max(120),
  slug: slugField,
  plan: z.string().min(2).max(40).optional(),
  limits: limitsSchema.optional(),
  branding: brandingSchema.optional(),
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  // The first client_admin. Not optional: a tenant nobody can sign in to is
  // not a tenant, and this is the flow the phase exists for.
  admin: z.object({
    email: z.string().email(),
    name: z.string().min(2).max(120).optional(),
  }),
});

// Neither clientId nor slug is editable — see EDITABLE in the controller.
const updateTenantSchema = z.object({
  companyName: z.string().min(2).max(120).optional(),
  plan: z.string().min(2).max(40).optional(),
  limits: limitsSchema.optional(),
  branding: brandingSchema.optional(),
  featureFlags: z.record(z.string(), z.boolean()).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

const lifecycleSchema = z.object({
  reason: z.string().max(500).optional(),
});

const createOperatorSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  role: z.enum(PLATFORM_ROLES),
});

const updateOperatorSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  role: z.enum(PLATFORM_ROLES).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

// SAP connection settings. `config` and `secrets` are intentionally loose here
// — only the driver knows what a valid gateway URL or system number is for
// itself, so shape is checked here and meaning in `driver.validateConfig`.
// Everything under `secrets` is write-only: no endpoint reads it back.
const sapConnectionSchema = z.object({
  driver: z.enum(DRIVER_KEYS),
  config: z.record(z.string(), z.any()).default({}),
  secrets: z.record(z.string(), z.string().max(4096).nullable()).default({}),
});

const sapPromoteSchema = z.object({
  environment: z.enum(ENVIRONMENTS),
  reason: z.string().max(500).optional(),
});

const mfaVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/, { message: 'Enter the six-digit code from your authenticator' }),
});

module.exports = {
  createTenantSchema,
  updateTenantSchema,
  lifecycleSchema,
  createOperatorSchema,
  updateOperatorSchema,
  mfaVerifySchema,
  sapConnectionSchema,
  sapPromoteSchema,
};
