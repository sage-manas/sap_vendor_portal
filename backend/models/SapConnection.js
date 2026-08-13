const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { DRIVERS, DEFAULT_DRIVER } = require('../sap/drivers');
const { generateDataKey, wrapDataKey, unwrapDataKey, encryptWithDataKey, decryptWithDataKey } = require('../utils/secretBox');

// One tenant's SAP configuration, per environment.
//
// Deliberately NOT tenant-scoped, for the same reason as AuditLog (ADR-0014):
// it is tenant *configuration*, written only from the platform plane, where no
// tenant is bound. Applying the plugin would make `withoutTenantScope()` the
// normal path on this collection, which is how an escape hatch stops being
// noticed. Instead `clientId` is an ordinary required indexed field, and every
// read goes through a finder that takes it as an argument.
//
// Credentials live in `secrets` and are envelope-encrypted: a random data key
// per connection encrypts each value, and the data key itself is wrapped under
// the master key. Nothing in this file has a getter that returns plaintext by
// accident — `decryptSecrets()` is a method with a name you can grep for, and
// `toJSON` strips both the ciphertext and the wrapped key.

const ENVIRONMENTS = ['sandbox', 'production'];

// The non-secret half of a connection. Free-form per driver — an OData base URL
// and service path mean nothing to an RFC gateway — so it is Mixed, validated
// by each driver's own `validateConfig`.
const testResultSchema = new Schema({
  ok:         { type: Boolean, required: true },
  message:    { type: String },
  latencyMs:  { type: Number },
  driver:     { type: String },
  detail:     { type: Schema.Types.Mixed },
  at:         { type: Date, default: Date.now },
  testedBy:   { type: String },
}, { _id: false });

const sapConnectionSchema = new Schema({
  clientId:    { type: String, required: true, index: true },
  environment: { type: String, enum: ENVIRONMENTS, required: true },

  driver: { type: String, enum: Object.keys(DRIVERS), default: DEFAULT_DRIVER, required: true },

  config: { type: Schema.Types.Mixed, default: {} },

  // secretName → `v2:…` ciphertext. Never returned by the API, never logged,
  // never passed to recordAudit.
  secrets: { type: Map, of: String, default: () => new Map() },

  // The connection's data key, wrapped under the master key (a `v1:` blob).
  wrappedDataKey: { type: String, select: false },

  lastTest: { type: testResultSchema, default: null },

  // Sandbox is where a connection is proven; production is what tenants
  // actually run against. `promotedAt` is set by the explicit promotion step,
  // never by an edit — see platformSap.controller.
  promotedAt:  { type: Date },
  promotedBy:  { type: String },

  createdBy:   { type: String },
  updatedBy:   { type: String },
}, { timestamps: true });

// One connection per tenant per environment. The uniqueness is what makes
// "configure" an upsert rather than a growing pile of half-edited rows.
sapConnectionSchema.index({ clientId: 1, environment: 1 }, { unique: true });

// Writes `values` into `secrets`, encrypted. A key mapped to null or '' is
// removed — that is how an operator clears a credential without a second
// endpoint. Keys absent from `values` are left alone, so editing a base URL
// does not require re-typing the password.
sapConnectionSchema.methods.setSecrets = function setSecrets(values = {}) {
  if (!Object.keys(values).length) return;

  let dataKey;
  if (this.wrappedDataKey) {
    dataKey = unwrapDataKey(this.wrappedDataKey);
  } else {
    dataKey = generateDataKey();
    this.wrappedDataKey = wrapDataKey(dataKey);
  }

  for (const [name, value] of Object.entries(values)) {
    if (value === null || value === '') this.secrets.delete(name);
    else this.secrets.set(name, encryptWithDataKey(dataKey, value));
  }
};

// The only way plaintext comes back out, and it exists for exactly one caller:
// the driver factory, which needs credentials to open a connection. Requires
// `wrappedDataKey`, which is `select: false`, so a document loaded for display
// physically cannot decrypt.
sapConnectionSchema.methods.decryptSecrets = function decryptSecrets() {
  if (!this.wrappedDataKey) return {};

  const dataKey = unwrapDataKey(this.wrappedDataKey);
  const out = {};
  for (const [name, ciphertext] of this.secrets.entries()) {
    out[name] = decryptWithDataKey(dataKey, ciphertext);
  }
  return out;
};

// Which credentials are set, without saying what they are. This is what the
// console renders: "password ✓ configured", never the value or its length.
sapConnectionSchema.methods.secretNames = function secretNames() {
  return [...this.secrets.keys()].sort();
};

// Defence in depth against the obvious accident: `res.json(connection)`.
sapConnectionSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.secrets;
    delete ret.wrappedDataKey;
    return ret;
  },
});

sapConnectionSchema.statics.ENVIRONMENTS = ENVIRONMENTS;

module.exports = mongoose.model('SapConnection', sapConnectionSchema);
module.exports.ENVIRONMENTS = ENVIRONMENTS;
