const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { retryDocumentWatch } = require('../jobs/syncState');

// The reconciliation queue (Phase 3 of docs/04-sap-runtime-engineering-plan.md):
// everything `pending` past its SLA, plus everything `failed` or `orphaned`,
// across every tenant and all six synced document types — the screen that
// converts a silent integration failure into a ticket someone closes.
//
// Six differently-shaped tables, so this is six queries merged in JS rather
// than one SQL UNION across columns that don't line up — simpler to read and
// to keep correct as the tables' own shapes evolve.
const PENDING_SLA_HOURS = Number(process.env.RECONCILIATION_PENDING_SLA_HOURS) || 4;

const DOCUMENT_TYPES = [
  { type: 'RFQ', table: 'rfqs' },
  { type: 'PurchaseOrder', table: 'purchase_orders' },
  { type: 'ASN', table: 'asns' },
  { type: 'GRN', table: 'grns' },
  { type: 'Invoice', table: 'invoices' },
  { type: 'Payment', table: 'payments' },
];

const rowsFor = async ({ type, table }, { clientId } = {}) => {
  const slaThreshold = new Date(Date.now() - PENDING_SLA_HOURS * 3600 * 1000);

  // withoutTenantScope + rawPrisma: this reads across every tenant by design
  // (the operator picks a tenant filter in the UI, not the database).
  const rows = await withoutTenantScope(() => (clientId
    ? rawPrisma.$queryRawUnsafe(
      `SELECT pk, "clientId", id, "sapSyncState", "sapSyncError", "sapSyncedAt", "updatedAt", "createdAt"
       FROM "${table}"
       WHERE "clientId" = $1
         AND ("sapSyncState" IN ('failed', 'orphaned')
           OR ("sapSyncState" = 'pending' AND "updatedAt" < $2))
       ORDER BY "updatedAt" ASC
       LIMIT 200`,
      clientId, slaThreshold,
    )
    : rawPrisma.$queryRawUnsafe(
      `SELECT pk, "clientId", id, "sapSyncState", "sapSyncError", "sapSyncedAt", "updatedAt", "createdAt"
       FROM "${table}"
       WHERE "sapSyncState" IN ('failed', 'orphaned')
          OR ("sapSyncState" = 'pending' AND "updatedAt" < $1)
       ORDER BY "updatedAt" ASC
       LIMIT 200`,
      slaThreshold,
    )));

  return rows.map((row) => ({ ...row, type }));
};

// @desc    Every RFQ/PO/ASN/GRN/Invoice/Payment that is not honestly `synced`
//          or `local` — failed, orphaned, or pending past its SLA.
// @route   GET /api/platform/reconciliation
// @access  platform:health:read
const listReconciliation = asyncHandler(async (req, res) => {
  const { clientId, type, state } = req.query;

  const wanted = type ? DOCUMENT_TYPES.filter((d) => d.type === type) : DOCUMENT_TYPES;
  const batches = await Promise.all(wanted.map((doc) => rowsFor(doc, { clientId })));
  let rows = batches.flat();

  if (state) rows = rows.filter((row) => row.sapSyncState === state);
  rows.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

  res.json({
    success: true,
    slaHours: PENDING_SLA_HOURS,
    total: rows.length,
    rows: rows.slice(0, 200),
  });
});

// @desc    Restart the watch behind one reconciliation row (ASN/Invoice —
//          job-backed types only; a PurchaseOrder reconciles on its own next
//          read, RFQ/GRN/Payment never appear here in practice — see the
//          note on their sapSyncState defaults in schema.prisma).
// @route   POST /api/platform/reconciliation/:type/:pk/retry
// @access  tenant:manage
const retryReconciliationRow = asyncHandler(async (req, res, next) => {
  const { type, pk } = req.params;
  const doc = DOCUMENT_TYPES.find((d) => d.type === type);
  if (!doc) return next(ApiError.badRequest(`Unknown document type "${type}"`));

  const result = await retryDocumentWatch(doc.table, pk, req);
  if (!result) {
    return next(ApiError.badRequest(`${type} has no watching job to retry — it reconciles on its own next SAP read`));
  }

  res.json({ success: true, job: result });
});

module.exports = { listReconciliation, retryReconciliationRow, DOCUMENT_TYPES, PENDING_SLA_HOURS };
