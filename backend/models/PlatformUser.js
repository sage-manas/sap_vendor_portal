const mongoose = require('mongoose');
const credentialsPlugin = require('./plugins/credentialsPlugin');
const { PLATFORM_ROLES, ROLES } = require('../config/roles');
const Schema = mongoose.Schema;

// Platform operators: super_admin and sap_manager. Deliberately NOT
// tenant-scoped and deliberately a separate collection from User — an operator
// has no clientId, and keeping the collections apart means a tenant query can
// never surface one (ADR-0008).
//
// MFA fields live here from Phase 2 so the enrolment data model is settled;
// Phase 3 makes enrolment mandatory before the platform console will load.

const platformUserSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  role: { type: String, enum: PLATFORM_ROLES, required: true, default: ROLES.SAP_MANAGER },
  status: { type: String, enum: ['Active', 'Suspended'], default: 'Active' },

  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: { type: String, select: false },
  mfaEnrolledAt: { type: Date },

  createdBy: { type: String },
}, { timestamps: true });

platformUserSchema.plugin(credentialsPlugin);

platformUserSchema.index({ role: 1 });
platformUserSchema.index({ status: 1 });

platformUserSchema.methods.canAuthenticate = function canAuthenticate() {
  return this.status === 'Active';
};

module.exports = mongoose.model('PlatformUser', platformUserSchema);
