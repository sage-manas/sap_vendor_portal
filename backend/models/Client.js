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
