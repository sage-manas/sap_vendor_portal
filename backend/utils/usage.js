const { prisma } = require('../db/prisma');
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

// One entry per metered thing. `limitField` is the flattened column on Client
// (models/Client.js's nested `limits.*` became limitVendors/limitRfqsPerMonth/
// limitStorageMb in the Prisma schema — see prisma/schema.prisma).
const MB = 1024 * 1024;

const METRICS = {
  vendors: {
    limitField: 'limitVendors',
    label: 'suppliers',
    count: () => prisma.vendor.count({}),
  },
  rfqsPerMonth: {
    limitField: 'limitRfqsPerMonth',
    label: 'RFQs this month',
    count: () => prisma.rFQ.count({ where: { createdAt: { gte: startOfMonth() } } }),
  },
  // Issue #116: limitStorageMb was settable, validated and shown in the
  // platform console, but nothing ever counted, enforced or displayed usage
  // against it — this is that count. Unlike the two metrics above, storage
  // is not "one more of a thing": a single upload can add many MB at once,
  // so assertCanCreate below takes an explicit amount for this metric rather
  // than assuming +1 (see its own comment).
  storageMb: {
    limitField: 'limitStorageMb',
    label: 'MB of storage',
    count: async () => {
      const { _sum } = await prisma.document.aggregate({ _sum: { size: true } });
      // Rounded here, once, so `used` is the same number everywhere it is
      // read — the workspace overview, the platform health board and the
      // enforcement check below all call this same function rather than
      // rounding three times and risking three different answers.
      return Number(((_sum.size || 0) / MB).toFixed(1));
    },
  },
};

// The metrics plan enforcement cares about, against the limits on Client.
const usageAgainstLimits = (client) => runWithTenant(client.clientId, async () => {
  const [vendors, rfqsThisMonth, storageMb] = await Promise.all([
    METRICS.vendors.count(),
    METRICS.rfqsPerMonth.count(),
    METRICS.storageMb.count(),
  ]);
  return {
    vendors: against(vendors, client[METRICS.vendors.limitField]),
    rfqsThisMonth: against(rfqsThisMonth, client[METRICS.rfqsPerMonth.limitField]),
    storageMb: against(storageMb, client[METRICS.storageMb.limitField]),
  };
});

// Plan enforcement: refuses a write that would push a tenant over its limit,
// counted fresh and checked before anything is created. Rebinds the tenant
// itself, so it is safe to call from an unauthenticated route (self-
// registration) that has no bound context yet, as well as from one that does.
//
// `amount` is how much of the metric this one call is about to add — 1 for
// every existing caller (a vendor, an RFQ: exactly one more of the thing),
// which is why it defaults to 1 and every call site written before storage
// needed no change. Storage is the first metric where that default is wrong:
// one upload can be a handful of KB or several MB, so the caller states how
// many MB this file is and the check is against the total *after* it lands,
// not just the total before it.
const assertCanCreate = (client, metricName, amount = 1) => runWithTenant(client.clientId, async () => {
  const metric = METRICS[metricName];
  const limit = client[metric.limitField];
  // Null/undefined means unlimited; 0 is a real limit ("no room at all") and
  // must not be read the same way `!limit` would read it.
  if (limit == null) return;

  const used = await metric.count();
  if (used + amount > limit) {
    throw new ApiError(
      402,
      `This workspace's plan allows ${limit} ${metric.label}. That limit has been reached.`,
      { reason: 'plan_limit_reached' }
    );
  }
});

module.exports = { usageAgainstLimits, assertCanCreate, against };
