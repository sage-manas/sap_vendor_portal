const mongoose = require('mongoose');
const crypto = require('crypto');
const tenantPlugin = require('./plugins/tenantPlugin');
const { TENANT_ROLES, SUPPLIER_ROLES } = require('../config/roles');
const Schema = mongoose.Schema;

// An outstanding invitation into one tenant. Covers both tenant staff
// (client_admin/buyer/finance → creates a User) and suppliers (vendor →
// creates a Vendor in Draft), so Phase 5's "invite a supplier from the
// dashboard" reuses this model rather than growing a second one.
//
// Only the token hash is stored; the raw token exists once, in the email.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const invitationSchema = new Schema({
  email: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, trim: true },
  role: { type: String, enum: [...TENANT_ROLES, ...SUPPLIER_ROLES], required: true },
  tokenHash: { type: String, required: true, index: true },
  status: { type: String, enum: ['Pending', 'Accepted', 'Revoked', 'Expired'], default: 'Pending' },
  expiresAt: { type: Date, required: true },
  invitedBy: { type: String },
  acceptedAt: { type: Date },
  revokedAt: { type: Date },
  // The account the acceptance produced, for the audit trail.
  acceptedAccountId: { type: String },
}, { timestamps: true });

invitationSchema.plugin(tenantPlugin);

invitationSchema.index({ clientId: 1, email: 1, status: 1 });
invitationSchema.index({ clientId: 1, status: 1 });

invitationSchema.methods.isRedeemable = function isRedeemable() {
  return this.status === 'Pending' && this.expiresAt > new Date();
};

const hashInviteToken = (rawToken) =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

const newInviteToken = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return { rawToken, tokenHash: hashInviteToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
};

module.exports = mongoose.model('Invitation', invitationSchema);
module.exports.hashInviteToken = hashInviteToken;
module.exports.newInviteToken = newInviteToken;
module.exports.INVITE_TTL_MS = INVITE_TTL_MS;
