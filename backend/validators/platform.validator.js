const { z } = require('zod');
const { PLATFORM_ROLES } = require('../config/roles');
const { DRIVER_KEYS } = require('../sap/drivers');
const { ENVIRONMENTS } = require('../db/sapConnectionHelpers');
const { isKnownStateName, gstinMatchesState } = require('../config/indianStates');

// Request shapes for the platform console. Roles come from the registry, so a
// seventh role is still a one-file change.

const slugField = z.string()
  .min(3).max(40)
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'Workspace address may contain lowercase letters, digits and hyphens, and cannot start or end with a hyphen',
  });

const limitsSchema = z.strictObject({
  vendors: z.number().int().positive().optional(),
  rfqsPerMonth: z.number().int().positive().optional(),
  storageMb: z.number().int().positive().optional(),
});

const brandingSchema = z.strictObject({
  logo: z.string().max(500).optional(),
  primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i, { message: 'Primary colour must be a hex value like #059669' }).optional(),
});

// The tenant's own GST registration (finding 4.4). Same expression
// validators/vendor.validator.js applies to a supplier's GSTIN — one legal
// identifier, one shape, whichever side of the trade holds it.
const gstinRegex = /^[0-9]{2}[A-Z0-9]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;

// Both are clearable: an operator who entered the wrong registration needs to
// be able to take it back out, and null is a state gst.service.js already
// handles honestly ("place of supply unknown", never "same state"). '' is
// accepted and stored as null rather than refused, because that is what an
// emptied form field sends.
const gstinField = z.union([z.string().regex(gstinRegex, { message: 'Invalid GSTIN format' }), z.literal('')]);

// Not free text. `isIntraState` compares this against the supplier's own
// state as a string, so a value outside the registry the supplier chose from
// can never match one — and the resulting mis-split is silent. See
// config/indianStates.js.
const stateField = z.union([
  z.string().refine(isKnownStateName, {
    message: 'State must be one of the Indian states and union territories the registry lists',
  }),
  z.literal(''),
]);

// A GSTIN's first two digits are its state code, so a GSTIN and a state that
// disagree mean one of the two was mistyped. Refused rather than silently
// preferring either: an operator can see which one is wrong, and neither
// guess here would be better than asking.
const gstinAgreesWithState = (body) => gstinMatchesState(body.gstin, body.state);
const GSTIN_STATE_MISMATCH = {
  message: 'This GSTIN\'s state code does not match the state selected',
  path: ['gstin'],
};

const createTenantSchema = z.strictObject({
  companyName: z.string().min(2).max(120),
  slug: slugField,
  plan: z.string().min(2).max(40).optional(),
  limits: limitsSchema.optional(),
  branding: brandingSchema.optional(),
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  // Optional at creation: an operator provisioning a workspace often does not
  // have the customer's GST registration in front of them yet, and a tenant
  // with no registration is a real, workable state (it just cannot derive a
  // place of supply until one is set).
  gstin: gstinField.optional(),
  state: stateField.optional(),
  // The first client_admin. Not optional: a tenant nobody can sign in to is
  // not a tenant, and this is the flow the phase exists for.
  admin: z.strictObject({
    email: z.string().email(),
    name: z.string().min(2).max(120).optional(),
  }),
}).refine(gstinAgreesWithState, GSTIN_STATE_MISMATCH);

// Neither clientId nor slug is editable — see EDITABLE in the controller.
const updateTenantSchema = z.strictObject({
  companyName: z.string().min(2).max(120).optional(),
  plan: z.string().min(2).max(40).optional(),
  limits: limitsSchema.optional(),
  branding: brandingSchema.optional(),
  featureFlags: z.record(z.string(), z.boolean()).optional(),
  gstin: gstinField.optional(),
  state: stateField.optional(),
})
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' })
  // Only checkable when both arrive together. A PUT that changes one alone is
  // checked against what is already stored, in the controller — the schema
  // cannot read the database.
  .refine((body) => body.gstin === undefined || body.state === undefined || gstinAgreesWithState(body), GSTIN_STATE_MISMATCH);

const lifecycleSchema = z.strictObject({
  reason: z.string().max(500).optional(),
});

const createOperatorSchema = z.strictObject({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  role: z.enum(PLATFORM_ROLES),
});

const updateOperatorSchema = z.strictObject({
  name: z.string().min(2).max(120).optional(),
  role: z.enum(PLATFORM_ROLES).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

// SAP connection settings. `config` and `secrets` are intentionally loose here
// — only the driver knows what a valid gateway URL or system number is for
// itself, so shape is checked here and meaning in `driver.validateConfig`.
// Everything under `secrets` is write-only: no endpoint reads it back.
const sapConnectionSchema = z.strictObject({
  driver: z.enum(DRIVER_KEYS),
  config: z.record(z.string(), z.any()).default({}),
  secrets: z.record(z.string(), z.string().max(4096).nullable()).default({}),
});

const sapPromoteSchema = z.strictObject({
  environment: z.enum(ENVIRONMENTS),
  reason: z.string().max(500).optional(),
});

const mfaVerifySchema = z.strictObject({
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
