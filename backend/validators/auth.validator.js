const { z } = require('zod');

const gstinRegex = /^[0-9]{2}[A-Z0-9]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
const panRegex = /^[A-Z0-9]{5}[0-9]{4}[A-Z]{1}$/i;
const phoneRegex = /^[6-9]\d{9}$/;

const registerSchema = z.object({
  // Optional: if omitted, the backend assigns a vendorId. Never trusted as
  // the sole source of a "real" id — only honored so existing test/dev
  // fixtures that supply one keep working.
  vendorId: z.string().min(3).max(50).optional(),
  password: z.string().min(6, { message: "Password must be at least 6 characters long" }),
  companyName: z.string().min(3).max(100),
  gstin: z.string().regex(gstinRegex, { message: "Invalid GSTIN format" }),
  pan: z.string().regex(panRegex, { message: "Invalid PAN format" }),
  email: z.string().email({ message: "Invalid email format" }),
  phone: z.string().regex(phoneRegex, { message: "Invalid phone number format" }).optional().or(z.literal('')),
  
  // Flat address & bank details
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  ifscCode: z.string().optional(),
  accountName: z.string().optional(),
  bankBranch: z.string().optional(),
});

const loginSchema = z.object({
  vendorIdOrEmail: z.string().min(1, { message: "Vendor ID or Email is required" }),
  password: z.string().min(1, { message: "Password is required" })
});

const forgotPasswordSchema = z.object({
  email: z.string().email({ message: "Invalid email format" })
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, { message: "Reset token is required" }),
  password: z.string().min(6, { message: "Password must be at least 6 characters long" })
});

// Passwords chosen through an invitation, a forced first-login change or the
// platform console all obey the same minimum. One schema fragment, so raising
// the bar is a one-line change.
const passwordField = z.string().min(6, { message: "Password must be at least 6 characters long" });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { message: "Current password is required" }),
  newPassword: passwordField
});

const acceptInvitationSchema = z.object({
  token: z.string().min(1, { message: "Invitation token is required" }),
  password: passwordField,
  name: z.string().min(2).max(120).optional()
});

const platformLoginSchema = z.object({
  email: z.string().email({ message: "Invalid email format" }),
  password: z.string().min(1, { message: "Password is required" })
});

module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  acceptInvitationSchema,
  platformLoginSchema,
  passwordField
};
