const { Prisma } = require('@prisma/client');
const {
  getTenantId,
  isUnscoped,
  hasTenantBinding,
  MissingTenantContextError,
} = require('../utils/tenantContext');

// The Prisma-side replacement for the old Mongoose tenant plugin (removed —
// see PROJECT_CONTEXT.md §0). Same contract: every read/write on a
// tenant-scoped model is filtered by the bound clientId, every create/update
// is stamped with it and stripped of any caller-supplied value, and any op
// with no tenant context throws instead of touching every tenant's rows.
// Platform-plane code opts out explicitly with withoutTenantScope().
//
// Model list mirrors config/tenantModels.js plus the child/line-item tables
// introduced by the relational schema (RfqItem, PurchaseOrderItem, ...) —
// every one of them carries its own `clientId` column so it can be scoped
// directly, without a parent join. Client, AuditLog, SapConnection,
// SapConnectionAudit and PlatformUser are deliberately absent: no plugin was
// ever applied to them under Mongoose, and none is applied here.
//
// SapJob and SapSchedule (jobs/queue.js) are absent for a different reason:
// the worker must claim across every tenant before it knows whose job it is
// (`FOR UPDATE SKIP LOCKED` in jobs/queue.js's claim(), with no clientId in
// the WHERE clause), then bind the tenant with runWithTenant() immediately
// after claiming. Adding either here makes claim() throw
// MissingTenantContextError and the worker never runs — do not "fix" that by
// adding them to this set.
const TENANT_SCOPED_MODELS = new Set([
  'Vendor',
  'User',
  'Invitation',
  'RFQ',
  'RfqItem',
  'RfqBid',
  'RfqBidUnitPrice',
  'RfqBidDocument',
  'RfqInvitedVendor',
  'PurchaseOrder',
  'PurchaseOrderItem',
  'InvoicePlan',
  'InvoicePlanLine',
  'ASN',
  'AsnItem',
  'GRN',
  'GrnItem',
  'Invoice',
  'InvoiceItem',
  'Payment',
  'ChatMessage',
  'Document',
  'SapLog',
]);

// Ops that read (or bulk-write) and accept an arbitrary `where` — these can be
// scoped by simply AND-ing `{ clientId }` in, no matter what shape the
// caller's `where` already has.
const WHERE_SCOPED_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'updateMany',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

// Ops whose `where` must stay EXACTLY a unique/compound-unique input shape —
// Prisma rejects an arbitrary AND filter here. These get the forcedWhere
// treatment below instead of a where-wrap.
const UNIQUE_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

// A Prisma `where` value is either a scalar equality, or — for a unique
// compound key like `clientId_id: { clientId, id }` — a plain object whose
// OWN keys are the real field names. Flattening lets findFirst filter on
// those fields directly (findFirst does not understand the synthetic
// `clientId_id` key name that only findUnique/update/delete/upsert accept).
const flattenUniqueWhere = (where = {}) => {
  const flat = {};
  for (const [key, value] of Object.entries(where)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      Object.assign(flat, value);
    } else {
      flat[key] = value;
    }
  }
  return flat;
};

// True if `where` (or one of its compound-key sub-objects) already names a
// clientId — i.e. we can correct it in place rather than needing a separate
// ownership check.
const whereNamesClientId = (where = {}) => {
  for (const value of Object.values(where)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value) && 'clientId' in value) {
      return true;
    }
  }
  return 'clientId' in where;
};

// Overrides any clientId this `where` already names with the bound tenant —
// including inside a compound-unique sub-object — without changing its shape.
// A caller-forged clientId (own or someone else's) can never select another
// tenant's row this way.
const forceClientId = (where = {}, clientId) => {
  const forced = { ...where };
  if ('clientId' in forced) forced.clientId = clientId;
  for (const [key, value] of Object.entries(forced)) {
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value) && 'clientId' in value) {
      forced[key] = { ...value, clientId };
    }
  }
  return forced;
};

// Strips any client-supplied attempt to write a different clientId. The
// bound tenant is the only authority on this field — mirrors scrubUpdate() in
// the old tenantPlugin.
const scrubClientId = (data) => {
  if (!data || typeof data !== 'object') return data;
  if ('clientId' in data) delete data.clientId;
  return data;
};

const guard = (model, operation) => {
  if (!hasTenantBinding()) {
    throw new MissingTenantContextError(model, operation);
  }
};

const notFoundError = (model) =>
  new Prisma.PrismaClientKnownRequestError(`No ${model} found`, {
    code: 'P2025',
    clientVersion: Prisma.prismaVersion.client,
  });

// Prisma property name for a model, e.g. 'RFQ' -> 'rFQ', 'SapLog' -> 'sapLog'.
const clientPropFor = (model) => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * Builds the extension. Takes the RAW (unextended) client so mutating
 * single-record ops (update/delete/upsert on a where that names no clientId,
 * e.g. a bare `{ pk }`) can pre-check tenant ownership with a plain findFirst
 * before the mutation runs — without recursing back through this same
 * extension, and without a circular import on backend/db/prisma.js (which is
 * what constructs this client in the first place).
 *
 * NOTE: Prisma Client Extensions only intercept the top-level operation you
 * call — a nested write (`prisma.rFQ.create({ data: { items: { create: [...] } } })`)
 * does NOT re-enter this extension for the nested RfqItem create. Controllers
 * performing nested tenant-scoped writes must pass `clientId` explicitly in
 * the nested payload, or — preferably — issue the child writes as their own
 * top-level calls so they pick up the same scoping everything else gets.
 */
const createTenantExtension = (rawClient) => Prisma.defineExtension({
  name: 'tenantScope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        guard(model, operation);
        if (isUnscoped()) {
          return query(args);
        }

        const clientId = getTenantId();

        if (UNIQUE_WHERE_OPS.has(operation)) {
          if (whereNamesClientId(args.where)) {
            // Compound key already carries a clientId sub-field — correct it
            // to the bound tenant in place, then run the op unchanged. Atomic:
            // no separate read is needed.
            args.where = forceClientId(args.where, clientId);
          } else if (operation !== 'upsert' || true) {
            // Bare unique key (e.g. `{ pk }`) with no clientId anywhere.
            // findUnique*: read-only, so a post-check is safe and cheap.
            // update/delete/upsert: mutating, so ownership must be confirmed
            // BEFORE the write — a post-check would be too late. This has a
            // small TOCTOU window (the row could change tenant between the
            // check and the write, which nothing in this schema's design
            // ever does in practice); full atomicity would need raw SQL.
            const flat = flattenUniqueWhere(args.where);
            delete flat.clientId;
            const owned = await rawClient[clientPropFor(model)].findFirst({ where: { ...flat, clientId } });

            if (operation === 'findUnique') {
              if (!owned) return null;
              args.where = forceClientId(args.where, clientId);
            } else if (operation === 'findUniqueOrThrow') {
              if (!owned) throw notFoundError(model);
              args.where = forceClientId(args.where, clientId);
            } else if (operation === 'update' || operation === 'delete') {
              if (!owned) throw notFoundError(model);
              // where is unchanged (already a bare unique key — safe now that
              // ownership is confirmed).
            } else if (operation === 'upsert') {
              // No existing row under this tenant with this key: upsert will
              // create. Nothing further to enforce here — the create branch
              // below stamps clientId regardless of what the caller passed.
            }
          }

          if (operation === 'update') scrubClientId(args.data);
          if (operation === 'upsert') {
            scrubClientId(args.update);
            args.create = { ...scrubClientId({ ...args.create }), clientId };
          }

          return query(args);
        }

        if (WHERE_SCOPED_OPS.has(operation)) {
          args.where = { AND: [args.where || {}, { clientId }] };
        }

        if (operation === 'createMany') {
          if (Array.isArray(args.data)) {
            args.data = args.data.map((row) => ({ ...scrubClientId({ ...row }), clientId }));
          }
          return query(args);
        }

        if (operation === 'updateMany') {
          scrubClientId(args.data);
          return query(args);
        }
        if (operation === 'deleteMany') {
          return query(args);
        }

        if (operation === 'create') {
          args.data = { ...scrubClientId({ ...args.data }), clientId };
        }

        return query(args);
      },
    },
  },
});

module.exports = { createTenantExtension, TENANT_SCOPED_MODELS };
