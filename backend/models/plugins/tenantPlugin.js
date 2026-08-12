const {
  getTenantId,
  isUnscoped,
  hasTenantBinding,
  MissingTenantContextError,
} = require('../../utils/tenantContext');

// Every read/write op we intercept. `estimatedDocumentCount` is deliberately
// absent: it cannot take a filter, so it can never be made tenant-safe — use
// countDocuments instead.
const QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
];

// Strips any client-supplied attempt to write a different clientId. The bound
// tenant is the only authority on this field.
const scrubUpdate = (update, clientId) => {
  if (!update || typeof update !== 'object') return;
  delete update.clientId;
  for (const key of Object.keys(update)) {
    if (key.startsWith('$') && update[key] && typeof update[key] === 'object') {
      delete update[key].clientId;
    }
  }
  if (clientId) {
    update.$setOnInsert = { ...(update.$setOnInsert || {}), clientId };
  }
};

/**
 * Makes a schema tenant-scoped.
 *
 * - reads/updates/deletes are filtered by the bound clientId
 * - documents are stamped with the bound clientId on save
 * - any op with no tenant context throws instead of touching every tenant's rows
 *
 * Platform-plane code opts out explicitly with withoutTenantScope().
 */
module.exports = function tenantPlugin(schema, options = {}) {
  const { index = true } = options;

  schema.add({
    clientId: {
      type: String,
      required: true,
      index,
    },
  });

  const guard = (modelName, op) => {
    if (!hasTenantBinding()) {
      throw new MissingTenantContextError(modelName, op);
    }
  };

  for (const op of QUERY_OPS) {
    schema.pre(op, function tenantScopeQuery() {
      guard(this.model?.modelName || 'Model', op);
      if (isUnscoped()) return;

      const clientId = getTenantId();
      this.setQuery({ ...this.getQuery(), clientId });

      if (typeof this.getUpdate === 'function' && this.getUpdate()) {
        scrubUpdate(this.getUpdate(), clientId);
      }
    });
  }

  schema.pre('aggregate', function tenantScopeAggregate() {
    guard(this.model?.()?.modelName || 'Model', 'aggregate');
    if (isUnscoped()) return;
    this.pipeline().unshift({ $match: { clientId: getTenantId() } });
  });

  // Stamp on create. Runs at validate time so `required: true` is satisfied by
  // the context rather than by every call site remembering to pass clientId.
  schema.pre('validate', function tenantStamp() {
    guard(this.constructor.modelName, 'save');
    if (isUnscoped()) return;

    const clientId = getTenantId();
    if (this.isNew) {
      this.clientId = clientId;
    } else if (this.clientId !== clientId) {
      // A document loaded under one tenant can never be saved into another.
      throw new Error(
        `Refusing to save ${this.constructor.modelName} ${this._id}: document belongs to ${this.clientId}, context is ${clientId}`
      );
    }
  });

  schema.pre('insertMany', function tenantStampMany(next, docs) {
    try {
      guard(this.modelName, 'insertMany');
    } catch (err) {
      return next(err);
    }
    if (!isUnscoped() && Array.isArray(docs)) {
      const clientId = getTenantId();
      docs.forEach((doc) => { doc.clientId = clientId; });
    }
    next();
  });
};

module.exports.QUERY_OPS = QUERY_OPS;
