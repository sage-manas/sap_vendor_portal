const { prisma, rawPrisma } = require('../db/prisma');
const { SAP_SYNC_STATE, isLegalSyncTransition } = require('../config/statuses');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const logger = require('../utils/logger');

// One place that knows which document a job kind watches and how to change
// its sapSyncState — shared by the controllers that enqueue a watch and the
// job handlers that resolve it, so "what happened to the job" and "what
// happened to the document" can never drift. Phase 3 of
// docs/04-sap-runtime-engineering-plan.md.
const DOCUMENT_FOR_KIND = {
  awaitGoodsReceipt: { delegate: () => prisma.aSN, idField: 'asnId' },
  awaitPaymentRun: { delegate: () => prisma.invoice, idField: 'invoiceId' },
};

const documentFor = (kind) => {
  const spec = DOCUMENT_FOR_KIND[kind];
  if (!spec) throw new Error(`jobs/syncState.js has no document mapping for job kind "${kind}"`);
  return spec;
};

// Must run inside the tenant binding the caller already holds — `prisma`
// (the tenant-extended client) throws otherwise, same as every other query.
const setSyncState = async (kind, args, state, extra = {}) => {
  const { delegate, idField } = documentFor(kind);
  const id = args?.[idField];
  if (!id) return;

  const current = await delegate().findFirst({ where: { id }, select: { sapSyncState: true } });
  if (!current) return; // the document is gone; nothing to update

  // `synced` is fully terminal — not just "no transition out", but no
  // further write at all, including a same-state re-assertion with a
  // *different* sapDocNumber. Without this, a stale duplicate answer racing
  // the real one could silently overwrite an already-correct document
  // number; isLegalSyncTransition's `from === to` shortcut alone would wave
  // that through since the state label itself would not change.
  if (current.sapSyncState === SAP_SYNC_STATE.SYNCED) {
    logger.warn(`[jobs] refusing to touch an already-synced ${kind} document`);
    return;
  }

  if (!isLegalSyncTransition(current.sapSyncState, state)) {
    // Not thrown: a stale/duplicate job outcome racing a newer one (or a
    // document that moved on its own, e.g. a manual reconciliation) must not
    // take down the operation it describes — same bargain utils/audit.js and
    // utils/sapLogger.js make. Loud in the log either way.
    logger.warn(`[jobs] refusing illegal sync-state transition for ${kind} ${id}: ${current.sapSyncState} -> ${state}`);
    return;
  }

  await delegate().updateMany({ where: { id }, data: { sapSyncState: state, ...extra } });
};

// Called by the controller that enqueues the watching job (po.controller.js's
// submitASN, invoice.controller.js's scheduleAwaitPaymentRun).
const markPending = (kind, args) => setSyncState(kind, args, SAP_SYNC_STATE.PENDING, { sapSyncError: null });

// Called by the job handler once the driver has found and persisted an
// answer (jobs/handlers/awaitGoodsReceipt.js / awaitPaymentRun.js).
const markSynced = (kind, args, sapDocNumber) => setSyncState(kind, args, SAP_SYNC_STATE.SYNCED, {
  sapDocNumber, sapSyncedAt: new Date(), sapSyncError: null,
});

// Called by jobs/worker.js on a thrown error that has not exhausted the
// job's retry budget yet — the job itself keeps retrying; this just records
// the last thing that went wrong, for the reconciliation queue.
const markFailed = (kind, args, errorMessage) => setSyncState(kind, args, SAP_SYNC_STATE.FAILED, {
  sapSyncError: errorMessage,
});

// Called by jobs/worker.js once a job is abandoned (maxAttempts exhausted
// with no answer, or an error on the final attempt).
const markOrphaned = (kind, args, errorMessage) => setSyncState(kind, args, SAP_SYNC_STATE.ORPHANED, {
  sapSyncError: errorMessage || 'SAP never answered — job abandoned after exhausting its retry budget',
});

// The reconciliation queue (controllers/platformReconciliation.controller.js)
// works from a table name, not a job kind — the inverse of DOCUMENT_FOR_KIND.
const KIND_FOR_TABLE = {
  asns: 'awaitGoodsReceipt',
  invoices: 'awaitPaymentRun',
};

/**
 * Resets the job watching one reconciliation-queue row back to pending, the
 * same way the platform jobs board's per-job retry does — this just resolves
 * a document (`table` + `pk`) to the job watching it first. Returns null when
 * the table has no job-backed watch (a PurchaseOrder reconciles on its own
 * next SAP read; RFQ/GRN/Payment never carry anything but `local`/`synced`
 * — see the notes on each in schema.prisma) or no job is found for it.
 */
const retryDocumentWatch = async (table, pk, req) => {
  const kind = KIND_FOR_TABLE[table];
  if (!kind) return null;

  const [row] = await withoutTenantScope(() => rawPrisma.$queryRawUnsafe(
    `SELECT id, "clientId" FROM "${table}" WHERE pk = $1::uuid`, pk,
  ));
  if (!row) return null;

  const { idField } = documentFor(kind);
  const dedupeKey = `${kind}:${row.clientId}:${row.id}`;
  const job = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { dedupeKey } }));
  if (!job) return null;

  // Lazy requires: jobs/queue.js and utils/audit.js would otherwise form a
  // require cycle with this module (queue.js doesn't need syncState.js at
  // load time, but keeping the cycle out entirely is simpler to reason about).
  const { retryByPk } = require('./queue');
  const { recordAudit } = require('../utils/audit');
  const { AUDIT_ACTIONS } = require('../config/auditActions');

  const updated = await retryByPk(job.pk);

  await runWithTenant(row.clientId, () => markPending(kind, { [idField]: row.id }).catch(() => {}));

  await recordAudit({
    action: AUDIT_ACTIONS.JOB_RETRIED,
    req,
    target: { type: 'SapJob', id: job.pk, label: `${kind} (${dedupeKey})` },
    meta: { clientId: row.clientId, kind, previousStatus: job.status, via: 'reconciliation-queue' },
    clientId: row.clientId,
  });

  return updated;
};

module.exports = {
  markPending, markSynced, markFailed, markOrphaned, retryDocumentWatch, DOCUMENT_FOR_KIND,
};
