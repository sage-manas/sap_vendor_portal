const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const tenantPlugin = require('./plugins/tenantPlugin');
const Schema = mongoose.Schema;

// vendorId is the link between user and our MongoDB vendor

const vendorSchema = new Schema({
  vendorId:       { type: String, required: true, unique: true }, // ← Local unique user/vendor ID
  clerkId:        { type: String },                               // ← Deprecated, kept for backward compatibility
  password:       { type: String, select: false },                // ← Hashed password (not returned by default)
  resetPasswordToken:   { type: String, select: false },
  resetPasswordExpires: { type: Date, select: false },
  role:           { type: String, enum: ['vendor', 'admin'], default: 'vendor' },
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
  state:          { type: String },
  postalCode:     { type: String },

  // Flat banking details
  bankName:       { type: String },
  accountNumber:  { type: String },
  ifscCode:       { type: String },
  accountName:    { type: String },
  bankBranch:     { type: String },

  // Uploaded compliance documents
  cancelledCheque: { type: String },
  panCardCopy:     { type: String },
  gstCertificate:  { type: String },
  incorporationCertificate: { type: String },
  msmeCertificate: { type: String },
  isoCertificate:  { type: String },
  itReturns:       { type: String },

  // GSTIN/PAN verification (required before a vendor can be approved)
  gstinVerified:  { type: Boolean, default: false },
  panVerified:    { type: Boolean, default: false },
  verifiedAt:     { type: Date },
  verificationDetails: { type: Schema.Types.Mixed },

  // SAP ERP synchronization metadata
  // Issued by the tenant's own SAP, so it is unique per tenant, not globally
  // (see the partial compound index below).
  sapVendorCode:  { type: String },
  status:         { type: String, enum: ['Draft', 'Pending', 'Pending Approval', 'Under Review', 'Approved', 'Rejected'], default: 'Draft' },
  rejectionReason:{ type: String },
  vendorCategory: { type: String },
  submittedAt:    { type: Date },
  approvedAt:     { type: Date }
}, { timestamps: true });

// Hash password before saving
vendorSchema.pre('save', async function() {
  if (!this.isModified('password') || !this.password) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password helper method
vendorSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

vendorSchema.plugin(tenantPlugin);

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
