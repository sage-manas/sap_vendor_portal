const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// The tenant. Deliberately NOT tenant-scoped itself: it is the thing the scope
// points at, and only the platform plane may list or mutate it.
const clientSchema = new Schema({
  clientId:    { type: String, required: true, unique: true },      // e.g. 'CLT-0001'
  companyName: { type: String, required: true, trim: true },
  slug:        { type: String, required: true, unique: true, lowercase: true, trim: true }, // subdomain
  status:      { type: String, enum: ['Trial', 'Active', 'Suspended', 'Terminated'], default: 'Trial' },
  plan:        { type: String, default: 'trial' },

  branding: {
    logo:         { type: String },
    primaryColor: { type: String },
  },

  featureFlags: { type: Schema.Types.Mixed, default: {} },

  // Everything else the tenant configures about itself: thresholds, notification
  // policy. The shape is not declared here on purpose — config/tenantSettings.js
  // is the registry that says which keys exist and what a valid value is, and a
  // second declaration would be a second place to forget (ADR-0023).
  settings: { type: Schema.Types.Mixed, default: {} },

  // Which SapConnection this tenant's traffic actually runs against. A tenant
  // stays on sandbox until an operator promotes it — this field *is* the
  // promotion, and nothing but the promote endpoint writes it.
  sapEnvironment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },

  limits: {
    vendors:      { type: Number, default: 50 },
    rfqsPerMonth: { type: Number, default: 100 },
    storageMb:    { type: Number, default: 1024 },
  },

  createdBy:    { type: String },
  activatedAt:  { type: Date },
  suspendedAt:  { type: Date },
  terminatedAt: { type: Date },
}, { timestamps: true });

clientSchema.index({ status: 1 });

// Only Trial and Active tenants may authenticate or transact.
clientSchema.methods.isOperational = function isOperational() {
  return this.status === 'Trial' || this.status === 'Active';
};

module.exports = mongoose.model('Client', clientSchema);
