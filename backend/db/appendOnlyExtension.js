const { Prisma } = require('@prisma/client');

// Replicates the throwing Mongoose pre-hooks on AuditLog and
// SapConnectionAudit (see models/AuditLog.js / models/SapConnectionAudit.js):
// both collections are append-only by construction, with no update or delete
// path anywhere in the application. Same error text as today, so any test or
// caller asserting on the message keeps working unchanged.
//
// This is layer 1 of two — layer 2 is a Postgres `REVOKE UPDATE, DELETE`
// grant on these tables (see prisma/migrations' initial migration SQL),
// which closes the gap this layer can't: a caller that bypasses Prisma
// entirely via `$queryRaw`.
const APPEND_ONLY_MODELS = {
  AuditLog: 'AuditLog is append-only: entries cannot be updated or deleted',
  SapConnectionAudit: 'SapConnectionAudit is append-only: entries cannot be updated or deleted',
};

const MUTATING_OPS = new Set(['update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

const appendOnlyExtension = Prisma.defineExtension({
  name: 'appendOnly',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const message = APPEND_ONLY_MODELS[model];
        if (message && MUTATING_OPS.has(operation)) {
          throw new Error(message);
        }
        return query(args);
      },
    },
  },
});

module.exports = { appendOnlyExtension, APPEND_ONLY_MODELS };
