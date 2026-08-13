const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// The append-only trail of everything that happened to a tenant's SAP
// configuration. AuditLog records that a connection changed; this records what
// it changed *from* and *to*, field by field, which is the question you
// actually ask at 2am when a tenant's integration stopped working.
//
// Not tenant-scoped, for the same reason as SapConnection itself. Append-only
// by the same mechanism as AuditLog: the pre-hooks below refuse updates and
// deletes outright, so "who edited the audit trail" is not a question anyone
// has to be able to answer.

const sapConnectionAuditSchema = new Schema({
  clientId:    { type: String, required: true, index: true },
  environment: { type: String, required: true },
  action:      { type: String, required: true },   // an AUDIT_ACTIONS 'sap.*' value

  driver:      { type: String },

  // Field-level before/after for the *non-secret* config only. A secret's
  // change is recorded as its name appearing in `secretsChanged` — never a
  // value, never a hash, never a length.
  changes:        { type: Schema.Types.Mixed, default: {} },
  secretsChanged: { type: [String], default: [] },

  result:      { type: Schema.Types.Mixed },       // test outcomes: { ok, message, latencyMs }

  actorId:     { type: String },
  actorEmail:  { type: String },
  actorRole:   { type: String },
  ip:          { type: String },

  at:          { type: Date, default: Date.now, index: true },
});

sapConnectionAuditSchema.index({ clientId: 1, at: -1 });
sapConnectionAuditSchema.index({ action: 1, at: -1 });

// Append-only, enforced the same way AuditLog enforces it: the hooks throw
// rather than calling `next`, because query middleware runs for both the
// document and the query forms of these operations and throwing is the one
// signal both honour.
const refuse = function refuseMutation() {
  throw new Error('SapConnectionAudit is append-only: entries cannot be updated or deleted');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  sapConnectionAuditSchema.pre(op, { query: true, document: false }, refuse);
}
sapConnectionAuditSchema.pre('save', function refuseEdit() {
  if (!this.isNew) throw new Error('SapConnectionAudit is append-only: entries cannot be edited');
});

module.exports = mongoose.model('SapConnectionAudit', sapConnectionAuditSchema);
