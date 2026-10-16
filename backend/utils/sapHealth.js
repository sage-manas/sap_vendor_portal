const { prisma } = require('../db/prisma');
const { runWithTenant } = require('./tenantContext');

// One tenant's SAP health, from its own SapLog traffic. Shared by the platform
// health board (every tenant, operators only) and the tenant-facing status in
// the app's top bar, so "healthy" means the same thing on both.
//
// No traffic is not the same as no problem: an idle tenant is `unknown`, never
// painted green.

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

const sapTrafficFor = async (clientId, windowHours) => runWithTenant(clientId, async () => {
  const windowStart = since(windowHours);

  const [total, failed, latest, lastSuccess] = await Promise.all([
    prisma.sapLog.count({ where: { timestamp: { gte: windowStart } } }),
    prisma.sapLog.count({ where: { timestamp: { gte: windowStart }, status: 'FAILED' } }),
    prisma.sapLog.findFirst({
      orderBy: { timestamp: 'desc' },
      select: { status: true, timestamp: true, name: true, errorMessage: true },
    }),
    prisma.sapLog.findFirst({
      where: { status: 'SUCCESS' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    }),
  ]);

  return {
    status: statusFromTraffic(total, failed),
    calls: total,
    failures: failed,
    errorRate: total ? Number((failed / total).toFixed(4)) : null,
    lastCall: latest ? { name: latest.name, status: latest.status, at: latest.timestamp, error: latest.errorMessage } : null,
    lastSuccessAt: lastSuccess?.timestamp || null,
  };
});

module.exports = { sapTrafficFor, statusFromTraffic, withCircuit };
