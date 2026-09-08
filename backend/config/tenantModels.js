// The registry of tenant-scoped collections: every model carrying the tenant
// plugin, in the order a human would want to read an export.
//
// Anything that must iterate "all of a tenant's data" — the offboarding export,
// the platform's per-tenant counts, Phase 7's usage metering — reads this list
// instead of keeping its own. Registering a model with the tenant plugin and
// adding it here is one change, and `tests/platform-console.test.js` asserts
// the two lists agree.

const TENANT_MODELS = [
  { name: 'Vendor', label: 'Suppliers', metric: 'vendors' },
  { name: 'User', label: 'Staff users', metric: 'users' },
  { name: 'Invitation', label: 'Invitations' },
  { name: 'RFQ', label: 'RFQs', metric: 'rfqs' },
  { name: 'PurchaseOrder', label: 'Purchase orders' },
  { name: 'ASN', label: 'Advance shipping notices' },
  { name: 'GRN', label: 'Goods receipts' },
  { name: 'Invoice', label: 'Invoices' },
  { name: 'Payment', label: 'Payments' },
  { name: 'ChatMessage', label: 'Messages' },
  { name: 'Document', label: 'Documents', metric: 'documents' },
  { name: 'SapLog', label: 'SAP log' },
];

const TENANT_MODEL_NAMES = TENANT_MODELS.map((entry) => entry.name);

// Prisma client property for a model name, e.g. 'RFQ' -> 'rFQ' (see
// backend/db/tenantExtension.js's clientPropFor, same rule — Prisma
// lowercases only the model name's first character).
const clientPropFor = (name) => name.charAt(0).toLowerCase() + name.slice(1);

// Loads the Prisma client lazily: requiring it at module load would drag the
// whole client into any file that only wants the names. Returns `count`/
// `findMany` rather than a raw model handle, since callers only ever want
// "how many rows" or "every row" for a whole-tenant operation (counts board,
// tenant export) — see backend/controllers/platformTenant.controller.js.
const tenantModels = () => {
  const { prisma } = require('../db/prisma');
  return TENANT_MODELS.map((entry) => {
    const client = prisma[clientPropFor(entry.name)];
    return {
      ...entry,
      count: () => client.count({}),
      findMany: () => client.findMany({}),
    };
  });
};

module.exports = { TENANT_MODELS, TENANT_MODEL_NAMES, tenantModels };
