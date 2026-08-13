const mongoose = require('mongoose');
const tenantPlugin = require('./plugins/tenantPlugin');
const credentialsPlugin = require('./plugins/credentialsPlugin');
const { TENANT_ROLES, ROLES } = require('../config/roles');
const Schema = mongoose.Schema;

// Tenant staff: client_admin, buyer, finance. Separate from Vendor by design
// (ADR-0007) — Vendor stays the supplier master record plus supplier login, and
// carries a whole onboarding/compliance surface that a buyer has no business
// having. Tenant-scoped: a User belongs to exactly one client.

const userSchema = new Schema({
  // Login identity is resolved before any tenant is known, so email is unique
  // across the whole platform, exactly as vendorId/email are on Vendor.
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: TENANT_ROLES, required: true, default: ROLES.BUYER },
  status: { type: String, enum: ['Invited', 'Active', 'Suspended'], default: 'Active' },
  phone: { type: String },
  jobTitle: { type: String },
  invitedBy: { type: String },
  invitedAt: { type: Date },
  activatedAt: { type: Date },
  suspendedAt: { type: Date },
}, { timestamps: true });

userSchema.plugin(credentialsPlugin);
userSchema.plugin(tenantPlugin);

userSchema.index({ clientId: 1, role: 1 });
userSchema.index({ clientId: 1, status: 1 });

userSchema.methods.canAuthenticate = function canAuthenticate() {
  return this.status === 'Active';
};

module.exports = mongoose.model('User', userSchema);
