const { prisma } = require('../db/prisma');
const ApiError = require('./ApiError');
const { runWithTenant } = require('./tenantContext');
const { settingValue } = require('../config/tenantSettings');

// The registry owns the default, as it owns every setting's — asked for with
// no client, `settingValue` answers with it.
const DEFAULT_TIMEZONE = settingValue(null, 'localization.timezone');
const tenantTimezone = (client) => settingValue(client, 'localization.timezone');

// The single place "usage against a plan limit" is computed. The platform
// health board, the workspace overview and plan enforcement all read the same
// numbers the same way, so a tenant is never told three different counts.

// Midnight on the 1st of the current month *in the tenant's own timezone*,
// as a UTC instant to compare a stored timestamp against.
//
// This used to be `new Date(now.getFullYear(), now.getMonth(), 1)` — the
// server's local calendar. The same workspace's monthly RFQ quota therefore
// rolled over whenever the host happened to say midnight: on a UTC server,
// 05:30 IST, so an RFQ raised at 02:00 IST on the 1st was still counted
// against the month that had already ended (issue #289). The answer must not
// depend on where the process runs.
//
// Asked of Intl rather than computed from an offset, because a zone does not
// have *an* offset — it has one per instant. New York is -04:00 on 1 Nov 2026
// and -05:00 on the 10th, so anything that measures elapsed wall-clock time
// and subtracts it lands an hour out across that transition, which is enough
// to put the first hour of the month in the wrong month. A zone this runtime
// does not recognise falls back to the registry's default rather than
// throwing inside a quota check.
const PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

const zonedParts = (date, timeZone) => {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone, ...PARTS }).formatToParts(date);
  const read = (type) => Number(formatted.find((part) => part.type === type).value);
  // 'en-GB' with hour12:false renders midnight as 24 in some ICU versions.
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') % 24, minute: read('minute'), second: read('second') };
};

// The zone's offset from UTC at one instant, in ms: how far that instant's
// wall-clock reading in the zone is from its reading in UTC.
const offsetAt = (date, timeZone) => {
  const here = zonedParts(date, timeZone);
  const asIfUtc = Date.UTC(here.year, here.month - 1, here.day, here.hour, here.minute, here.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
};

const known = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
};

const startOfMonth = (timeZone = DEFAULT_TIMEZONE, now = new Date()) => {
  const zone = known(timeZone) ? timeZone : DEFAULT_TIMEZONE;

  // The wall-clock moment wanted: midnight on the 1st of whatever month it
  // currently is *there*. Read as if it were UTC, it is the instant shifted
  // by the zone's offset — so subtract the offset to get back to the real one.
  const here = zonedParts(now, zone);
  const wallClock = Date.UTC(here.year, here.month - 1, 1, 0, 0, 0);

  // Twice, because the offset to subtract is the one in force *at the answer*,
  // not at `now`, and the two differ either side of a DST change. The first
  // pass lands within a couple of hours; the second uses the offset actually
  // in force there. A further pass cannot move it: no zone changes offset
  // twice within hours of a month boundary.
  const firstPass = new Date(wallClock - offsetAt(now, zone));
  return new Date(wallClock - offsetAt(firstPass, zone));
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
    // The only metric with a window, so the only one that takes the tenant's
    // timezone. The other two count everything a tenant has and ignore it.
    count: (timeZone) => prisma.rFQ.count({ where: { createdAt: { gte: startOfMonth(timeZone) } } }),
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
    METRICS.rfqsPerMonth.count(tenantTimezone(client)),
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

  const used = await metric.count(tenantTimezone(client));
  if (used + amount > limit) {
    throw new ApiError(
      402,
      `This workspace's plan allows ${limit} ${metric.label}. That limit has been reached.`,
      { reason: 'plan_limit_reached' }
    );
  }
});

module.exports = { usageAgainstLimits, assertCanCreate, against, startOfMonth };
