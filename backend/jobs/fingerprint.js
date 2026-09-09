const crypto = require('crypto');

// Response fingerprinting (Phase 4.2 of docs/04-sap-runtime-engineering-plan.md)
// — the real win for sweep cost: hash the *normalised* response before
// parsing it, compare to the cursor's last fingerprint (SapSyncCursor), and
// if it matches, do nothing — no parse, no diff, no writes, no events. A
// quiet sweep costs exactly one HTTP call and one hash.
//
// Getting the normalisation right is the whole point: two calls that
// returned the same underlying data must fingerprint identically even when
// SAP varies key order or stamps a fresh timestamp/correlation id on each
// response. Get it wrong and this either never matches (defeating the point)
// or always matches (silently dropping real changes) — see
// tests/sap-fingerprint.test.js for the two failure modes this guards.

// Fields SAP (or our own wrapper's stamp()) varies per call regardless of
// whether the underlying document changed. Feed-specific volatile fields are
// merged in by the caller, not hardcoded here — a sweep knows its own
// response shape better than this module does.
const DEFAULT_VOLATILE_KEYS = ['timestamp', 'requestId', 'correlationId', 'syncedAt', 'source'];

// Recursively sorts object keys (arrays keep their order — position is
// meaningful for a list of rows) and drops any volatile key at any depth.
const normalize = (value, volatileKeys) => {
  if (Array.isArray(value)) return value.map((item) => normalize(item, volatileKeys));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value)
      .filter((key) => !volatileKeys.has(key))
      .sort()
      .reduce((acc, key) => {
        acc[key] = normalize(value[key], volatileKeys);
        return acc;
      }, {});
  }
  if (value instanceof Date) return value.toISOString();
  return value;
};

/**
 * sha256 of the normalised response, as a hex string. `extraVolatileKeys`
 * merges into the default set — pass the feed-specific fields SAP is known
 * to vary (e.g. a page-generation timestamp the mock/real driver stamps).
 */
const fingerprint = (data, { extraVolatileKeys = [] } = {}) => {
  const volatileKeys = new Set([...DEFAULT_VOLATILE_KEYS, ...extraVolatileKeys]);
  const normalized = normalize(data, volatileKeys);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
};

module.exports = { fingerprint, normalize, DEFAULT_VOLATILE_KEYS };
