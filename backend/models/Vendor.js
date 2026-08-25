const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const credentialsPlugin = require('./plugins/credentialsPlugin');
const { SUPPLIER_ROLES, ROLES } = require('../config/roles');
const { VENDOR_STATUS, VENDOR_STATUSES } = require('../config/statuses');
const Schema = mongoose.Schema;

// vendorId is the link between user and our MongoDB vendor

const vendorSchema = new Schema({
  vendorId:       { type: String, required: true, unique: true }, // ← Local unique user/vendor ID
  clerkId:        { type: String },                               // ← Deprecated, kept for backward compatibility
  // Credentials (password, reset tokens, mustChangePassword) come from
  // credentialsPlugin so all three identity collections behave identically.
  // Vendor is the supplier plane only: tenant staff live in the User
  // collection (ADR-0007), so 'admin' is no longer a Vendor role.
  role:           { type: String, enum: SUPPLIER_ROLES, default: ROLES.VENDOR },
  companyName:    { type: String, required: true, trim: true },
  tradeName:      { type: String, trim: true },
  businessType:   { type: String },
  incorporationDate: { type: String },
  gstin:          { type: String, required: true, unique: true, uppercase: true },
  gstType:        { type: String },
  pan:            { type: String, required: true, uppercase: true },
  cin:            { type: String },
  msmeNumber:     { type: String },
  tdsSection:     { type: String },
  email:          { type: String, required: true, unique: true, lowercase: true },
  phone:          { type: String },
  
  // Flat address properties
  address:        { type: String },
  city:           { type: String },
  // `state` is kept (not renamed) for backward compatibility with existing
  // records/tests that already wrote free-text India state names here. New
  // registrations (Phase 7) populate `country` + `region` instead — `region`
  // is a country-scoped state/province CODE (see RegistrationView.jsx's
  // country/region picker and sap/mappings/vendor-create.map.js, which reads
  // `region`/`country`, not `state`, for the SAP payload). `state` is left
  // for any legacy reader that still expects it and is no longer written by
  // the registration form.
  state:          { type: String },
  country:        { type: String },
  region:         { type: String },
  postalCode:     { type: String },

  // SAP purchasing/finance fields collected on the portal (Phase 7 —
  // VENDOR_CR contract). Plain-English on the form; see
  // sap/mappings/vendor-create.map.js for where each lands in the SAP payload.
  paymentTerms:   { type: String },
  paymentMethod:  { type: String },
  currency:       { type: String },
  incoterms1:     { type: String },
  incoterms2:     { type: String },
  doubleInvoiceCheck:          { type: Boolean, default: false },
  grBasedInvoiceVerification:  { type: Boolean, default: false },

  // Flat banking details
  bankName:       { type: String },
  accountNumber:  { type: String },
  ifscCode:       { type: String },
  accountName:    { type: String },
  bankBranch:     { type: String },

  // Uploaded compliance documents. Stored as the full { documentId,
  // originalName, url } the uploads API returns — Mixed rather than String
  // because that's what FileUploadZone hands back and what the review UI
  // needs to show a real filename instead of a bare id.
  cancelledCheque: { type: Schema.Types.Mixed },
  panCardCopy:     { type: Schema.Types.Mixed },
  gstCertificate:  { type: Schema.Types.Mixed },
  msmeCertificate: { type: Schema.Types.Mixed },

  // GSTIN/PAN verification (required before a vendor can be approved)
  gstinVerified:  { type: Boolean, default: false },
  panVerified:    { type: Boolean, default: false },
  verifiedAt:     { type: Date },
  verificationDetails: { type: Schema.Types.Mixed },

  // SAP ERP synchronization metadata
  // Issued by the tenant's own SAP, so it is unique per tenant, not globally
  // (see the partial compound index below).
  sapVendorCode:  { type: String },
  status:         { type: String, enum: VENDOR_STATUSES, default: VENDOR_STATUS.DRAFT },
  rejectionReason:{ type: String },
  vendorCategory: { type: String },
  submittedAt:    { type: Date },
  approvedAt:     { type: Date }
}, { timestamps: true });

vendorSchema.plugin(credentialsPlugin);
vendorSchema.plugin(tenantPlugin);

// Suppliers may sign in from Draft onwards — the portal is where they finish
// onboarding. Only an explicit rejection closes the door.
vendorSchema.methods.canAuthenticate = function canAuthenticate() {
  return this.status !== VENDOR_STATUS.REJECTED;
};

// Indexes.
// vendorId / email / gstin stay GLOBALLY unique: login resolves an account
// before any tenant is known, so a supplier's login identity must be
// unambiguous across the whole platform (ADR-0002 in DECISIONS.md).
vendorSchema.index({ clientId: 1, status: 1 });
vendorSchema.index({ clientId: 1, vendorId: 1 });
vendorSchema.index(
  { clientId: 1, sapVendorCode: 1 },
  { unique: true, partialFilterExpression: { sapVendorCode: { $type: 'string' } } }
);

module.exports = mongoose.model('Vendor', vendorSchema);
