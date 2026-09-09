// Shared by jobs/handlers/sweepPurchaseOrders.js, sweepPayments.js and
// sweepQuotations.js — "which vendors are due, and did anything change" is
// the same question for all three feeds (Phase 4 of
// docs/04-sap-runtime-engineering-plan.md), only the SAP call and what to do
// with a changed answer differ.
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { fingerprint } = require('./fingerprint');
const { laneFor, intervalFor } = require('./adaptivePolling');

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000; // "activity in the last hour" — adaptivePolling's fast-lane trigger

// Which vendors (of this tenant, with a SAP vendor code — one with none has
// nothing SAP could possibly answer about) are due for a sweep on this feed
// right now, each carrying its own SapSyncCursor (a fresh, zero-value one if
// this is its first sweep) and the lane it was just classified into.
const dueVendors = async (clientId, feed) => {
  const vendors = await prisma.vendor.findMany({ where: { sapVendorCode: { not: null } } });
  if (!vendors.length) return [];

  const cursors = await withoutTenantScope(() => rawPrisma.sapSyncCursor.findMany({
    where: { clientId, feed, vendorCode: { in: vendors.map((v) => v.sapVendorCode) } },
  }));
  const cursorByCode = new Map(cursors.map((c) => [c.vendorCode, c]));

  const now = new Date();
  const due = [];

  for (const vendor of vendors) {
    const cursor = cursorByCode.get(vendor.sapVendorCode) || {
      clientId, feed, vendorCode: vendor.sapVendorCode, watermark: null, fingerprint: null, lastRunAt: null, quietTicks: 0,
    };

    // Never swept before: always due, on its first (fastest) lane check.
    if (!cursor.lastRunAt) {
      due.push({ vendor, cursor, lane: 'fast' });
      continue;
    }

    const [openWatchCount, recentLogCount, openCommercialCount] = await Promise.all([
      prisma.aSN.count({ where: { vendorId: vendor.vendorId, status: 'Submitted' } }),
      prisma.sapLog.count({ where: { vendorId: vendor.vendorId, timestamp: { gte: new Date(now - ACTIVITY_WINDOW_MS) } } }),
      prisma.purchaseOrder.count({ where: { vendorId: vendor.vendorId, status: { notIn: ['Paid'] } } }),
    ]);

    const lane = laneFor({
      hasOpenWatch: openWatchCount > 0,
      activeWithinLastHour: recentLogCount > 0,
      hasOpenCommercialDocument: openCommercialCount > 0,
    });

    const dueAt = new Date(cursor.lastRunAt.getTime() + intervalFor(lane, cursor.quietTicks));
    if (dueAt <= now) due.push({ vendor, cursor, lane });
  }

  return due;
};

/**
 * Fingerprints `data` against the vendor's cursor, upserts the cursor
 * (fingerprint/lastRunAt/quietTicks — never touches `watermark`, which is
 * the handler's own business if it uses one), and reports whether anything
 * actually changed. Unchanged means the handler's own work stops here — no
 * parse, no diff, no writes, no events (Phase 4.2's whole cost saving).
 */
const recordSweepTick = async ({ clientId, feed, vendorCode, data, extraVolatileKeys }) => {
  const newFingerprint = fingerprint(data, { extraVolatileKeys });

  const existing = await withoutTenantScope(() => rawPrisma.sapSyncCursor.findUnique({
    where: { clientId_feed_vendorCode: { clientId, feed, vendorCode } },
  }));

  const changed = !existing || existing.fingerprint !== newFingerprint;
  const quietTicks = changed ? 0 : (existing?.quietTicks || 0) + 1;

  await withoutTenantScope(() => rawPrisma.sapSyncCursor.upsert({
    where: { clientId_feed_vendorCode: { clientId, feed, vendorCode } },
    create: { clientId, feed, vendorCode, fingerprint: newFingerprint, lastRunAt: new Date(), quietTicks: 0 },
    update: { fingerprint: newFingerprint, lastRunAt: new Date(), quietTicks },
  }));

  return { changed };
};

module.exports = { dueVendors, recordSweepTick, ACTIVITY_WINDOW_MS };
