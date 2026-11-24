const { prisma, rawPrisma } = require('../db/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withoutTenantScope } = require('../utils/tenantContext');
const { withVendorNames } = require('../utils/vendorNames');
const { todayIn, tenantTimezone } = require('../utils/usage');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { ASN_STATUS, SAP_SYNC_STATE } = require('../config/statuses');
const { retryByPk } = require('../jobs/queue');
const { markPending } = require('../jobs/syncState');
const { ASN_INCLUDE, formatAsn } = require('../services/asn.service');

// The buying organisation's ASN monitor (ASN design screen B1), behind the
// workspace's Shipments page: what is due at a plant today, what is waiting
// for approval, what SAP has not taken, and what is late.
//
// "Today" is the tenant's own calendar day (localization.timezone), because a
// supplier's expected-arrival date is a calendar date — stored as that day's
// UTC midnight — and the question is whether it is *this plant's* today.

// Sent, and not yet all received: the shipments a plant is expecting.
const ON_THE_WAY = [ASN_STATUS.SUBMITTED, ASN_STATUS.IN_TRANSIT, ASN_STATUS.PARTIALLY_RECEIVED];
const SYNC_ERRORS = [SAP_SYNC_STATE.FAILED, SAP_SYNC_STATE.ORPHANED, SAP_SYNC_STATE.NEEDS_MANUAL_MATCH];
const JOB_STOPPED = ['failed', 'abandoned'];
const SECTION_LIMIT = 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Jobs whose failure is a shipment's SAP error. The delivery job's failure
// does not move the ASN's sapSyncState (that follows the goods receipt), so
// it is read off the job itself.
const JOB_KINDS = ['createInboundDelivery', 'awaitGoodsReceipt'];
const jobKey = (kind, clientId, asnId) => `${kind}:${clientId}:${asnId}`;

const stoppedJobsFor = (clientId, asnIds) => withoutTenantScope(() => rawPrisma.sapJob.findMany({
  where: {
    clientId,
    status: { in: JOB_STOPPED },
    dedupeKey: { in: asnIds.flatMap((id) => JOB_KINDS.map((kind) => jobKey(kind, clientId, id))) },
  },
  select: { pk: true, kind: true, status: true, lastError: true, dedupeKey: true },
}));

// @desc    The ASN monitor's sections for one plant (or all) and one day
// @route   GET /api/asns/monitor?plant=&date=YYYY-MM-DD
// @access  Tenant staff (workspace:read + asn:read) — tenant-wide, so never a supplier
const getAsnMonitor = asyncHandler(async (req, res) => {
  const { clientId } = req;
  const { plant } = req.query;
  const today = todayIn(tenantTimezone(req.client));
  const date = req.query.date || today;
  if (!DAY.test(date) || Number.isNaN(Date.parse(date))) throw ApiError.badRequest('date must be YYYY-MM-DD');

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const atPlant = plant ? { plant } : {};
  const query = (where, orderBy = { estimatedDeliveryDate: 'asc' }) => prisma.aSN.findMany({
    where: { ...atPlant, ...where }, include: ASN_INCLUDE, orderBy, take: SECTION_LIMIT,
  });

  // A shipment whose delivery or receipt job stopped, wherever its status is.
  const open = await prisma.aSN.findMany({
    where: { ...atPlant, status: { notIn: [ASN_STATUS.CANCELLED, ASN_STATUS.REJECTED, ASN_STATUS.RECEIVED] } },
    select: { id: true },
  });
  const stopped = await stoppedJobsFor(clientId, open.map((row) => row.id));
  const stoppedAsnIds = [...new Set(stopped.map((job) => job.dedupeKey.split(':').slice(2).join(':')))];

  const [expected, pendingApproval, sapErrors, overdue, plantRows] = await Promise.all([
    query({ status: { in: ON_THE_WAY }, estimatedDeliveryDate: { gte: dayStart, lt: dayEnd } }),
    query({ status: ASN_STATUS.PENDING_APPROVAL }, { submittedAt: 'asc' }),
    query({ OR: [{ sapSyncState: { in: SYNC_ERRORS } }, { id: { in: stoppedAsnIds } }] }, { updatedAt: 'asc' }),
    // Late is measured against the plant's real today, whatever date is picked.
    query({ status: { in: ON_THE_WAY }, estimatedDeliveryDate: { lt: todayStart } }),
    prisma.aSN.findMany({ where: { plant: { not: null } }, select: { plant: true }, distinct: ['plant'] }),
  ]);

  // What went wrong, per shipment, for the SAP errors section.
  const errorFor = (asn) => {
    const jobs = stopped.filter((job) => job.dedupeKey.endsWith(`:${asn.id}`));
    return asn.sapSyncError || jobs.map((job) => job.lastError).find(Boolean) || 'SAP did not answer';
  };

  const shape = async (rows, extra) => withVendorNames(rows.map((row) => ({ ...formatAsn(row), ...(extra ? extra(row) : {}) })));

  res.json({
    date,
    today,
    plant: plant || null,
    plants: plantRows.map((row) => row.plant).sort(),
    expected: await shape(expected),
    pendingApproval: await shape(pendingApproval),
    sapErrors: await shape(sapErrors, (row) => ({ sapError: errorFor(row) })),
    overdue: await shape(overdue),
  });
});

// @desc    Restart SAP's work on one shipment after it stopped
// @route   POST /api/asns/:asnId/retry
// @access  Tenant admin (asn:approve)
//
// The workspace's own "retry posting" (B1): the platform's reconciliation
// queue does the same for its operators, and this is the tenant admin's way
// to it for their own shipments. Only stopped jobs are restarted; a job still
// waiting or running is left alone.
const retryAsnSap = asyncHandler(async (req, res) => {
  const { clientId } = req;
  const asn = await prisma.aSN.findFirst({ where: { id: req.params.asnId } });
  if (!asn) throw ApiError.notFound('Shipment not found');
  if ([ASN_STATUS.CANCELLED, ASN_STATUS.REJECTED, ASN_STATUS.PENDING_APPROVAL].includes(asn.status)) {
    throw ApiError.badRequest(`A shipment that is '${asn.status}' has nothing in SAP to retry.`);
  }

  const stopped = await stoppedJobsFor(clientId, [asn.id]);
  if (!stopped.length && !SYNC_ERRORS.includes(asn.sapSyncState)) {
    throw ApiError.badRequest('Nothing has stopped for this shipment: SAP is still being asked.');
  }
  for (const job of stopped) {
    await retryByPk(job.pk);
  }
  // The receipt watch's document goes back to pending with it — the
  // reconciliation queue's retry does the same (jobs/syncState.js).
  if (SYNC_ERRORS.includes(asn.sapSyncState)) {
    const watch = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({ where: { dedupeKey: jobKey('awaitGoodsReceipt', clientId, asn.id) } }));
    if (watch && !stopped.some((job) => job.pk === watch.pk)) await retryByPk(watch.pk);
    await markPending('awaitGoodsReceipt', { asnId: asn.id });
  }

  await recordAudit({
    action: AUDIT_ACTIONS.JOB_RETRIED,
    req,
    target: { type: 'ASN', id: asn.id, label: `${asn.id} (SAP work)` },
    meta: { kinds: stopped.map((job) => job.kind), via: 'asn-monitor' },
  });

  const latest = await prisma.aSN.findFirst({ where: { pk: asn.pk }, include: ASN_INCLUDE });
  res.json({ message: 'SAP is being asked again.', asn: formatAsn(latest) });
});

module.exports = { getAsnMonitor, retryAsnSap };
