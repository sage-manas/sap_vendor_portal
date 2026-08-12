const mongoose = require('mongoose');
const { ALL_AUDIT_ACTIONS } = require('../config/auditActions');
const Schema = mongoose.Schema;

// The audit trail for both planes.
//
// Deliberately NOT tenant-plugin-scoped (ADR-0014): a platform action such as
// creating an operator has no tenant at all, and the console's whole job is to
// read across tenants. `clientId` is therefore optional and set explicitly by
// `utils/audit.js` — which stamps the bound tenant when there is one, so a
// tenant-plane action can never be recorded without its clientId.
//
// Append-only by construction: there is no update or delete path in the
// application, and the model refuses both (see below).

const auditLogSchema = new Schema({
  // null for platform-plane actions that concern no single tenant.
  clientId:  { type: String, default: null, index: true },

  actorId:   { type: String, required: true },   // account _id, or a script name
  actorRole: { type: String, required: true },
  actorEmail: { type: String },
  plane:     { type: String, enum: ['platform', 'tenant', 'supplier', 'system'], required: true },

  action:    { type: String, required: true, enum: ALL_AUDIT_ACTIONS },
  // What was acted upon: { type: 'Client', id: 'CLT-0007', label: 'Acme Ltd' }
  target:    {
    type:  { type: String },
    id:    { type: String },
    label: { type: String },
  },

  // Free-form context. Never put a secret here — `recordAudit` redacts, but the
  // rule is "do not pass it in the first place".
  meta:      { type: Schema.Types.Mixed, default: {} },

  ip:        { type: String },
  at:        { type: Date, default: Date.now, index: true },
}, { timestamps: false });

// The explorer's three query shapes: newest-first overall, per tenant, and per
// action. Each is served by an index rather than a collection scan.
auditLogSchema.index({ at: -1 });
auditLogSchema.index({ clientId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });
auditLogSchema.index({ actorId: 1, at: -1 });

// Append-only, enforced rather than documented. The hooks throw rather than
// calling `next`: query middleware here runs for both the document and the
// query forms of these operations, and throwing is the one signal both honour.
const refuse = function refuseMutation() {
  throw new Error('AuditLog is append-only: entries cannot be updated or deleted');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditLogSchema.pre(op, { query: true, document: false }, refuse);
}
auditLogSchema.pre('save', function refuseEdit() {
  if (!this.isNew) throw new Error('AuditLog is append-only: entries cannot be edited');
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
