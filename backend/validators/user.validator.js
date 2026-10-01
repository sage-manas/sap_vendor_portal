const { z } = require('zod');
const { TENANT_ROLES } = require('../config/roles');

// Role lists come from the registry — never re-typed here.
const inviteUserSchema = z.strictObject({
  email: z.string().email({ message: "Invalid email format" }),
  name: z.string().min(2).max(120).optional(),
  role: z.enum(TENANT_ROLES)
});

const inviteVendorSchema = z.strictObject({
  email: z.string().email({ message: "Invalid email format" }),
  name: z.string().min(2).max(120).optional()
});

const updateUserSchema = z.strictObject({
  role: z.enum(TENANT_ROLES).optional(),
  name: z.string().min(2).max(120).optional(),
  phone: z.string().max(20).optional(),
  jobTitle: z.string().max(120).optional()
});

const userStatusSchema = z.strictObject({
  status: z.enum(['Active', 'Suspended'])
});

module.exports = { inviteUserSchema, inviteVendorSchema, updateUserSchema, userStatusSchema };
