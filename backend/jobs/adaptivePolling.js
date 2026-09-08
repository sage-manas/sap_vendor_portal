// Adaptive polling (Phase 4.3 of docs/04-sap-runtime-engineering-plan.md) —
// where the scale comes from. Not every vendor deserves the same cadence:
//
//   fast   (30s-60s)   vendors with an open targeted watch, or activity in
//                      the last hour
//   normal (5-15 min)  vendors with an open PO or an unpaid invoice
//   slow   (1h-24h)    everyone else, backing off as the sweep keeps finding
//                      nothing new
//
// The lane itself is *derived fresh every sweep* from live facts (does this
// vendor have an open watch right now?) — nothing about "which lane" is
// stored. The one thing SapSyncCursor carries across sweeps is `quietTicks`:
// consecutive sweeps in a row whose fingerprint didn't change. Combined with
// fingerprinting (jobs/fingerprint.js), a tenant with 5,000 vendors ends up
// polling the ~40 that matter frequently and the rest rarely — the same
// profile a real SAP delta API would give you, achieved entirely on this
// side of the wire (see Deferred B in the plan for what ABAP would still buy).

const LANES = {
  fast: { baseMs: 30_000, capMs: 60_000 },
  normal: { baseMs: 5 * 60_000, capMs: 15 * 60_000 },
  slow: { baseMs: 60 * 60_000, capMs: 24 * 60 * 60_000 },
};

const LANE_KEYS = Object.keys(LANES);

/**
 * Which lane a vendor belongs in *this sweep*, from facts the caller already
 * had to look up to run the sweep at all (open jobs, recent activity, open
 * commercial documents) — never persisted, always recomputed.
 */
const laneFor = ({ hasOpenWatch, activeWithinLastHour, hasOpenCommercialDocument }) => {
  if (hasOpenWatch || activeWithinLastHour) return 'fast';
  if (hasOpenCommercialDocument) return 'normal';
  return 'slow';
};

/**
 * The actual delay before this vendor's next sweep: the lane's base
 * interval, backed off within the lane's own range as quietTicks grows —
 * never crossing into a slower lane's territory (that's laneFor's job, not
 * this function's). Exponential, capped, matching jobs/backoff.js's shape
 * for the same reason: a handful of doublings gets to the cap fast, and
 * jitter avoids every quiet vendor in a lane waking on the same tick.
 */
const intervalFor = (lane, quietTicks = 0) => {
  const { baseMs, capMs } = LANES[lane] || LANES.slow;
  const scaled = baseMs * 2 ** Math.min(Math.max(quietTicks, 0), 10);
  const capped = Math.min(scaled, capMs);
  const jitter = capped * (0.9 + Math.random() * 0.2); // +/-10%
  return Math.round(jitter);
};

const nextRunAt = (lane, quietTicks = 0, now = new Date()) =>
  new Date(now.getTime() + intervalFor(lane, quietTicks));

/**
 * The next quietTicks value for SapSyncCursor, given whether this sweep's
 * fingerprint matched the last one. Any change resets it to zero — a vendor
 * that just did something is exactly the vendor worth checking again soon,
 * which intervalFor already expresses via quietTicks=0 sitting at the lane's
 * base (fastest-within-lane) interval.
 */
const nextQuietTicks = (current = 0, { changed }) => (changed ? 0 : current + 1);

module.exports = { LANES, LANE_KEYS, laneFor, intervalFor, nextRunAt, nextQuietTicks };
