const ApiError = require('./ApiError');
const { runWithTenant } = require('./tenantContext');

// The single place "usage against a plan limit" is computed. The platform
// health board, the workspace overview and plan enforcement all read the same
// numbers the same way, so a tenant is never told three different counts.

const startOfMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

// null limit means unlimited: "no limit" and "no room left" must render —
// and enforce — differently, never as the same zero.
const against = (used, limit) => ({
  used,
  limit: limit ?? null,
  ratio: limit ? Number((used / limit).toFixed(3)) : null,
  breached: Boolean(limit && used > limit),
});

// One entry per metered thing, lazily requiring its model so this module can
// be pulled in from anywhere without dragging in the whole model graph.
const METRICS = {
  vendors: {
    limitKey: 'vendors',
    label: 'suppliers',
    count: () => require('../models/Vendor').countDocuments({}),
  },
  rfqsPerMonth: {
    limitKey: 'rfqsPerMonth',
    label: 'RFQs this month',
    count: () => require('../models/RFQ').countDocuments({ createdAt: { $gte: startOfMonth() } }),
  },
};

// The metrics plan enforcement cares about, against the limits on Client.
const usageAgainstLimits = (client) => runWithTenant(client.clientId, async () => {
  const [vendors, rfqsThisMonth] = await Promise.all([
    METRICS.vendors.count(),
    METRICS.rfqsPerMonth.count(),
  ]);
  return {
    vendors: against(vendors, client.limits?.vendors),
    rfqsThisMonth: against(rfqsThisMonth, client.limits?.rfqsPerMonth),
  };
});

// Plan enforcement: refuses a write that would push a tenant over its limit,
// counted fresh and checked before anything is created. Rebinds the tenant
// itself, so it is safe to call from an unauthenticated route (self-
// registration) that has no bound context yet, as well as from one that does.
const assertCanCreate = (client, metricName) => runWithTenant(client.clientId, async () => {
  const metric = METRICS[metricName];
  const limit = client.limits?.[metric.limitKey];
  // Null/undefined means unlimited; 0 is a real limit ("no room at all") and
  // must not be read the same way `!limit` would read it.
  if (limit == null) return;

  const used = await metric.count();
  if (used >= limit) {
    throw new ApiError(
      402,
      `This workspace's plan allows ${limit} ${metric.label}. That limit has been reached.`,
      { reason: 'plan_limit_reached' }
    );
  }
});

module.exports = { usageAgainstLimits, assertCanCreate, against };
