const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { retryDocumentWatch } = require('../jobs/syncState');
const { SAP_SYNC_STATE } = require('../config/statuses');

// The reconciliation queue (Phase 3 of docs/04-sap-runtime-engineering-plan.md):
// everything `pending` past its SLA, plus everything `failed` or `orphaned`,
// across every tenant and all six synced document types — the screen that
// converts a silent integration failure into a ticket someone closes.
//
// Six differently-shaped tables, so this is six queries merged in JS rather
// than one SQL UNION across columns that don't line up — simpler to read and
// to keep correct as the tables' own shapes evolve.
const PENDING_SLA_HOURS = Number(process.env.RECONCILIATION_PENDING_SLA_HOURS) || 4;

// One page of rows per request, merged across the six types. The page is
// capped; `total` is not — it comes from a COUNT(*) over the same WHERE, so
// the screen can say "showing 200 of 1,431" instead of quietly claiming the
// backlog is 200 (issue #286).
const PAGE_SIZE = 200;

const DOCUMENT_TYPES = [
  { type: 'RFQ', table: 'rfqs' },
  { type: 'PurchaseOrder', table: 'purchase_orders' },
  { type: 'ASN', table: 'asns' },
  { type: 'GRN', table: 'grns' },
  { type: 'Invoice', table: 'invoices' },
  { type: 'Payment', table: 'payments' },
];

// The states the queue is about. `synced` and `local` are both *success*
// states (see config/statuses.js), so they are not filterable here — asking
// for them is a mistake worth a 400, not an empty list that reads like "none
// of your documents are synced".
const QUEUE_STATES = [
  SAP_SYNC_STATE.PENDING,
  SAP_SYNC_STATE.FAILED,
  SAP_SYNC_STATE.ORPHANED,
  SAP_SYNC_STATE.NEEDS_MANUAL_MATCH,
];

const COLUMNS = 'pk, "clientId", id, "sapSyncState", "sapSyncError", "sapSyncedAt", "updatedAt", "createdAt"';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cursor paging is keyed on the sort key itself — `(updatedAt, pk)` — rather
// than an offset, so rows arriving or being fixed mid-scroll can't make the
// next page skip or repeat. The pk tiebreak is what makes the order total:
// six types routinely share an `updatedAt` to the millisecond.
const encodeCursor = (row) => `${new Date(row.updatedAt).toISOString()}|${row.pk}`;

const decodeCursor = (raw) => {
  const sep = String(raw).lastIndexOf('|');
  if (sep <= 0) return null;
  const updatedAt = new Date(String(raw).slice(0, sep));
  const pk = String(raw).slice(sep + 1);
  if (Number.isNaN(updatedAt.getTime()) || !UUID_RE.test(pk)) return null;
  return { updatedAt, pk };
};

// One WHERE for both branches (with and without `clientId`) and for both
// queries (the page and its COUNT), so the predicate can't drift between
// what is counted and what is shown.
//
// The `state` filter belongs here and not in JS: applied afterwards it would
// run *after* the per-type LIMIT, so a type with a page's worth of older
// pending rows would hide its own failed ones (issue #286).
//
// 'needs_manual_match' (issue #64 — an ambiguous SAP match, e.g. two
// periodic-invoicing-plan invoices SAP shows the same amount for) surfaces
// unconditionally, same as 'failed'/'orphaned': a retry alone never resolves
// it, so it must not wait out the SLA window a merely-slow 'pending' row
// does. Keep in sync with config/statuses.js's SAP_SYNC_STATE.
const buildWhere = ({ clientId, state, cursor }) => {
  const slaThreshold = new Date(Date.now() - PENDING_SLA_HOURS * 3600 * 1000);
  const params = [];
  const clauses = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (clientId) clauses.push(`"clientId" = ${bind(clientId)}`);

  if (state === SAP_SYNC_STATE.PENDING) {
    clauses.push(`("sapSyncState" = ${bind(state)} AND "updatedAt" < ${bind(slaThreshold)})`);
  } else if (state) {
    clauses.push(`"sapSyncState" = ${bind(state)}`);
  } else {
    clauses.push(`("sapSyncState" IN (${bind(SAP_SYNC_STATE.FAILED)}, ${bind(SAP_SYNC_STATE.ORPHANED)}, ${bind(SAP_SYNC_STATE.NEEDS_MANUAL_MATCH)})
         OR ("sapSyncState" = ${bind(SAP_SYNC_STATE.PENDING)} AND "updatedAt" < ${bind(slaThreshold)}))`);
  }

  const countWhere = `WHERE ${clauses.join('\n         AND ')}`;
  const countParams = [...params];

  if (cursor) {
    clauses.push(`("updatedAt", pk) > (${bind(cursor.updatedAt)}::timestamptz, ${bind(cursor.pk)}::uuid)`);
  }

  return {
    countWhere,
    countParams,
    pageWhere: `WHERE ${clauses.join('\n         AND ')}`,
    pageParams: params,
  };
};

// withoutTenantScope + rawPrisma: this reads across every tenant by design
// (the operator picks a tenant filter in the UI, not the database).
const rowsFor = async ({ type, table }, filters) => {
  const {
    countWhere, countParams, pageWhere, pageParams,
  } = buildWhere(filters);

  const [rows, counted] = await withoutTenantScope(() => Promise.all([
    rawPrisma.$queryRawUnsafe(
      `SELECT ${COLUMNS}
       FROM "${table}"
       ${pageWhere}
       ORDER BY "updatedAt" ASC, pk ASC
       LIMIT ${PAGE_SIZE}`,
      ...pageParams,
    ),
    rawPrisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM "${table}" ${countWhere}`,
      ...countParams,
    ),
  ]));

  return { type, rows: rows.map((row) => ({ ...row, type })), total: counted[0].count };
};

// @desc    Every RFQ/PO/ASN/GRN/Invoice/Payment that is not honestly `synced`
//          or `local` — failed, orphaned, or pending past its SLA.
// @route   GET /api/platform/reconciliation
// @access  platform:health:read
const listReconciliation = asyncHandler(async (req, res, next) => {
  const { clientId, type, state, cursor: rawCursor } = req.query;

  if (state && !QUEUE_STATES.includes(state)) {
    return next(ApiError.badRequest(`Unknown state "${state}" — expected one of ${QUEUE_STATES.join(', ')}`));
  }

  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return next(ApiError.badRequest('Malformed cursor'));

  const wanted = type ? DOCUMENT_TYPES.filter((d) => d.type === type) : DOCUMENT_TYPES;
  const batches = await Promise.all(wanted.map((doc) => rowsFor(doc, { clientId, state, cursor })));

  const merged = batches.flatMap((batch) => batch.rows);
  merged.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt)
    || a.pk.localeCompare(b.pk));
  const rows = merged.slice(0, PAGE_SIZE);

  // More to come either because the merge overflowed the page, or because one
  // type filled its own LIMIT and may hold rows past it.
  const hasMore = merged.length > PAGE_SIZE || batches.some((b) => b.rows.length === PAGE_SIZE);

  res.json({
    success: true,
    slaHours: PENDING_SLA_HOURS,
    total: batches.reduce((sum, b) => sum + b.total, 0),
    byType: Object.fromEntries(batches.map((b) => [b.type, b.total])),
    pageSize: PAGE_SIZE,
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null,
    rows,
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

module.exports = {
  listReconciliation, retryReconciliationRow, DOCUMENT_TYPES, PENDING_SLA_HOURS, PAGE_SIZE, QUEUE_STATES,
};
