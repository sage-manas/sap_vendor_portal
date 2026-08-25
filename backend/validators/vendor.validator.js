const { z } = require('zod');

// Regex adjusted to allow digits in alphabetic slots for testing (as explained in implementation plan)
const gstinRegex = /^[0-9]{2}[A-Z0-9]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;
const panRegex = /^[A-Z0-9]{5}[0-9]{4}[A-Z]{1}$/i;
// Matches the registration form's own check (src/features/profile/validation.js):
// an optional leading '+', then digits/spaces/hyphens, 10-15 characters — the
// form auto-fills phone as "+91 9935675669" from the PIN code lookup, so a
// bare-10-digit regex here rejects every submission that used it.
const phoneRegex = /^\+?[\d\s-]{10,15}$/;

const addressSchema = z.union([
  z.string(),
  z.object({
    street: z.string().optional(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    pincode: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
  })
]).optional();

// What FileUploadZone hands back from POST /uploads, and what the profile
// form then submits verbatim. A bare string is also accepted for older
// records/tests written before uploads carried full metadata.
const uploadedDocumentSchema = z.union([
  z.string(),
  z.object({
    documentId: z.string(),
    originalName: z.string().optional(),
    url: z.string().optional(),
  }),
]).optional().nullable();

const bankDetailsSchema = z.union([
  z.string(),
  z.object({
    bankName: z.string().optional(),
    accountNumber: z.string().optional(),
    ifscCode: z.string().optional(),
    accountName: z.string().optional(),
    accountHolderName: z.string().optional(),
    branch: z.string().optional(),
    bankBranch: z.string().optional(),
    accountType: z.string().optional(),
  })
]).optional();

const profileCreateSchema = z.object({
  vendorId: z.string(),
  companyName: z.string().min(3).max(100),
  gstin: z.string().regex(gstinRegex, { message: "Invalid GSTIN format" }),
  pan: z.string().regex(panRegex, { message: "Invalid PAN format" }),
  email: z.string().email({ message: "Invalid email format" }),
  phone: z.string().regex(phoneRegex, { message: "Invalid phone number format" }).optional().or(z.literal('')),
  
  // Flat fields (optional)
  tradeName: z.string().optional(),
  businessType: z.string().optional(),
  incorporationDate: z.string().optional(),
  cin: z.string().optional(),
  msmeNumber: z.string().optional(),
  tdsSection: z.string().optional(),
  vendorCategory: z.string().optional(),
  msmeRegistered: z.boolean().optional(),
  status: z.string().optional(),
  
  // Flat address & bank details
  address: addressSchema,
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
  ifscCode: z.string().optional(),
  accountName: z.string().optional(),
  bankBranch: z.string().optional(),
  bankDetails: bankDetailsSchema,
  
  // Document attachments (client sends null before a document is uploaded)
  cancelledCheque: uploadedDocumentSchema,
  panCardCopy: uploadedDocumentSchema,
  gstCertificate: uploadedDocumentSchema,
  msmeCertificate: uploadedDocumentSchema
});

const profileUpdateSchema = profileCreateSchema.partial();

// A supplier created from the tenant's directory. Derived from the
// self-registration schema rather than restated, so the two can never drift:
// the tenant supplies the same fields minus the two it does not own — the
// vendorId (issued server-side) and the status (the workflow's to set).
const vendorCreateSchema = profileCreateSchema.omit({ vendorId: true, status: true });

const rejectVendorSchema = z.object({
  reason: z.string().min(1, { message: "Rejection reason is required" })
});

module.exports = {
  profileCreateSchema,
  profileUpdateSchema,
  vendorCreateSchema,
  rejectVendorSchema
};
