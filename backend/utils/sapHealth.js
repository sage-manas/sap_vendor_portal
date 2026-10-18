const { prisma } = require('../db/prisma');
const { runWithTenant } = require('./tenantContext');

// One tenant's SAP health, from its own SapLog traffic. Shared by the platform
// health board (every tenant, operators only) and the tenant-facing status in
// the app's top bar, so "healthy" means the same thing on both.
//
// What counts as SAP traffic: calls to SAP itself, with a final outcome.
//  - KYC rows are GSTIN/PAN checks against a third-party service, and SYS rows
//    are the portal's own events — neither says anything about SAP, and a KYC
//    outage must not paint SAP red (or a KYC success paint it green).
//  - PENDING rows are deferred calls still waiting for SAP's answer; counting
//    them as calls but never as failures would bias the rate towards healthy.
//
// No traffic is not the same as no problem: an idle tenant is `unknown`, never
// painted green.

const SAP_CALL_TYPES = ['BAPI', 'RFC', 'OData', 'IDoc'];
const RESOLVED = ['SUCCESS', 'FAILED'];

const since = (hours) => new Date(Date.now() - hours * 3600 * 1000);

const statusFromTraffic = (total, failed) => (
  total === 0 ? 'unknown'
    : failed === 0 ? 'healthy'
      : failed / total > 0.25 ? 'failing' : 'degraded'
);

/**
 * An open circuit breaker outranks the traffic counts. We stopped calling SAP,
 * so the counts stop moving, and a reading of them alone would quietly turn
 * green at the worst possible moment.
 */
const withCircuit = (status, circuit) => (circuit?.state === 'open' ? 'failing' : status);

/**
 * @param {string} clientId
 * @param {number} windowHours
 * @param {object} [options]
 * @param {string} [options.vendorId]      only this supplier's own traffic
 * @param {boolean} [options.includeLatest] the most recent call, error text
 *   included — for the operators' board only
 */
const sapTrafficFor = async (clientId, windowHours, { vendorId, includeLatest = false } = {}) =>
  runWithTenant(clientId, async () => {
    const scope = { type: { in: SAP_CALL_TYPES }, ...(vendorId ? { vendorId } : {}) };

    const [byStatus, lastSuccess, latest] = await Promise.all([
      prisma.sapLog.groupBy({
        by: ['status'],
        where: { ...scope, status: { in: RESOLVED }, timestamp: { gte: since(windowHours) } },
        _count: true,
      }),
      prisma.sapLog.findFirst({
        where: { ...scope, status: 'SUCCESS' },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      }),
      includeLatest
        ? prisma.sapLog.findFirst({
          where: scope,
          orderBy: { timestamp: 'desc' },
          select: { status: true, timestamp: true, name: true, errorMessage: true },
        })
        : null,
    ]);

    const count = (status) => byStatus.find((row) => row.status === status)?._count || 0;
    const failed = count('FAILED');
    const total = failed + count('SUCCESS');

    return {
      status: statusFromTraffic(total, failed),
      calls: total,
      failures: failed,
      errorRate: total ? Number((failed / total).toFixed(4)) : null,
      lastSuccessAt: lastSuccess?.timestamp || null,
      ...(includeLatest && {
        lastCall: latest ? { name: latest.name, status: latest.status, at: latest.timestamp, error: latest.errorMessage } : null,
      }),
    };
  });

module.exports = { sapTrafficFor, statusFromTraffic, withCircuit, SAP_CALL_TYPES };
