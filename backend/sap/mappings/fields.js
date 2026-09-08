// SAP's field rules, owned in one place so no driver can forget one — Phase 2
// of docs/04-sap-runtime-engineering-plan.md.
//
// Today: LIFNR (vendor code) was passed through unpadded in several places in
// s4odata.driver.js; there was no MATNR length enforcement or 40-char TXZ01
// truncation; and — the dangerous one — a unit of measure read back from SAP
// was used (or defaulted to 'EA') without ever being validated against a
// known mapping. That default is how a carton silently becomes a piece in a
// buyer's ledger. This registry is the fix: `encodeForSap` pads/upper/trims/
// maps or throws, and `decodeFromSap` is the reverse for display.

class SapFieldError extends Error {
  constructor(field, value, reason) {
    super(`SAP field ${field} rejected "${value}": ${reason}`);
    this.code = 'sap_field_invalid';
    this.statusCode = 422;
    this.field = field;
  }
}

const trim = (v) => String(v ?? '').trim();
const upper = (v) => trim(v).toUpperCase();
const digits = (v) => trim(v).replace(/\D/g, '');
const pad = (v, n) => String(v).padStart(n, '0');

// SAP's internal MEINS codes and the free-text a supplier or buyer might type
// for the same unit, both mapping to one canonical ISO-ish code. Deliberately
// not exhaustive — an unmapped unit throws (see uomToIso) rather than
// guessing, because guessing here is exactly the bug this registry exists to
// stop.
// Deliberately does not include "carton"/"cartons" — that gap is the running
// example (here, in jobs and in the tests) of a real unit a buyer will
// eventually type that isn't mapped yet. Add it here — a fifteen-minute fix —
// once ABAP confirms which SAP UoM it should become; guessing now is exactly
// the bug this registry exists to stop.
const UOM_TO_ISO = {
  each: 'PCE', ea: 'PCE', pc: 'PCE', pcs: 'PCE', piece: 'PCE', pieces: 'PCE', pce: 'PCE',
  box: 'BOX', boxes: 'BOX',
  kg: 'KGM', kgs: 'KGM', kilogram: 'KGM', kilograms: 'KGM', kgm: 'KGM',
  litre: 'L', litres: 'L', liter: 'L', liters: 'L', l: 'L',
  metre: 'MTR', metres: 'MTR', meter: 'MTR', meters: 'MTR', m: 'MTR', mtr: 'MTR',
  set: 'SET', sets: 'SET',
  pair: 'PR', pairs: 'PR', pr: 'PR',
};

// The friendly label decodeFromSap('MEINS', ...) shows a supplier — SAP's own
// 3-letter code is not something anyone outside MM should have to read.
const ISO_TO_LABEL = {
  PCE: 'Each', BOX: 'Box', KGM: 'Kg', L: 'Litre', MTR: 'Metre', SET: 'Set', PR: 'Pair',
};

const uomToIso = (value) => {
  const key = trim(value);
  const iso = ISO_TO_LABEL[key.toUpperCase()] ? key.toUpperCase() : UOM_TO_ISO[key.toLowerCase()];
  if (!iso) throw new SapFieldError('MEINS', value, 'unmapped unit');
  return iso;
};

const SAP_FIELDS = {
  LIFNR: { label: 'Vendor code',    max: 10, encode: (v) => pad(digits(v), 10), decode: (v) => digits(v).replace(/^0+(?=\d)/, '') },
  MATNR: { label: 'Material',       max: 18, encode: (v) => upper(trim(v)) },
  EBELN: { label: 'Purchase order', max: 10, encode: (v) => pad(digits(v), 10), decode: (v) => digits(v).replace(/^0+(?=\d)/, '') },
  TXZ01: { label: 'Short text',     max: 40, encode: (v) => trim(v).slice(0, 40) },
  MEINS: { label: 'Unit',           max: 3,  encode: uomToIso, decode: (v) => ISO_TO_LABEL[upper(v)] || trim(v) },
  WAERS: { label: 'Currency',       max: 5,  encode: (v) => upper(trim(v)) },
};

/**
 * Pad, upper, truncate, map — or throw. Never defaults; an unrepresentable
 * value is a `SapFieldError`, not a best guess. Returns the input unchanged
 * for null/undefined/empty string — nothing to encode, and a required-field
 * check is the caller's job, not this registry's.
 */
const encodeForSap = (field, value) => {
  const spec = SAP_FIELDS[field];
  if (!spec) throw new Error(`Unknown SAP field "${field}" — add it to sap/mappings/fields.js`);
  if (value === null || value === undefined || value === '') return value;

  const encoded = spec.encode(value);
  if (encoded.length > spec.max) {
    throw new SapFieldError(field, value, `exceeds ${spec.max} characters after encoding (got ${encoded.length})`);
  }
  return encoded;
};

/** The reverse, for display: strip leading zeros, map a code back to a label. */
const decodeFromSap = (field, value) => {
  const spec = SAP_FIELDS[field];
  if (!spec) throw new Error(`Unknown SAP field "${field}" — add it to sap/mappings/fields.js`);
  if (value === null || value === undefined || value === '') return value;
  return spec.decode ? spec.decode(value) : value;
};

// --- Applying a method's `fields` declaration (contract.js) to call args ---
//
// Dot-path only (e.g. 'vendor.sapVendorCode') — no [] array traversal. Every
// current call site needing this is a top-level scalar (LIFNR/EBELN on
// `vendor`/`po`/`invoice`); nothing today sends line-item arrays (MATNR/TXZ01/
// MEINS) outbound to SAP (see contract.js — there is no delivery/invoice
// create). Extend this if/when one does, rather than guessing at the shape
// now.

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// Clones only the objects along `path`, leaving everything else — including
// sibling arrays — as the original reference. `args` (and the SapConnection-
// resolved documents inside it) must never be mutated in place: they can be
// shared, reused fixtures or live Prisma results a caller still holds.
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  let cursor = clone;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = cursor[key];
    cursor[key] = next && typeof next === 'object' ? (Array.isArray(next) ? [...next] : { ...next }) : {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return clone;
};

/**
 * Runs `encodeForSap` over every path a contract method declares in its
 * `fields` map, returning a new args object — `args` itself is untouched.
 * Called from sap/index.js's wrapImmediate/wrapDeferred, before the driver
 * (and therefore the circuit breaker) ever sees the call, so a rejected
 * field is a caller/data bug, not a SAP failure, and never trips the breaker.
 */
const applyFieldEncoding = (fields, args) => {
  if (!fields) return args;
  let result = args;
  for (const [path, sapField] of Object.entries(fields)) {
    const value = getPath(args, path);
    if (value === undefined) continue;
    result = setPath(result, path, encodeForSap(sapField, value));
  }
  return result;
};

module.exports = {
  SAP_FIELDS,
  SapFieldError,
  UOM_TO_ISO,
  encodeForSap,
  decodeFromSap,
  applyFieldEncoding,
};
