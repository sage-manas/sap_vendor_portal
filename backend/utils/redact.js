// One place that decides what must not reach a log.
//
// Three writers used to carry their own, partial idea of it: the winston format
// (a short list of secret-shaped key names, and nothing for bank or tax data),
// the request logger (relied on that format, and logged the request URL raw) and
// the SAP communication log (stored its payload exactly as sent). A supplier's
// bank account number, IFSC, PAN and GSTIN, and a payment's UTR, therefore sat in
// plain text in backend/logs and in sap_logs, which nobody treats as sensitive.
//
// Two treatments:
//   * secrets (passwords, tokens, keys)  -> "[REDACTED]", no tail
//   * identifiers (account no., IFSC, PAN, GSTIN, UTR) -> "****" + last four,
//     enough for a person to tell two records apart and for support to match one
//     against what the supplier reads out, not enough to use.
//
// Identifiers are found by key name in structured data and by shape in free
// text (PAN, GSTIN and IFSC have fixed formats). A bare account number in free
// text has no shape to find; the discipline there is to log it under a key.

const TAIL = 4;
const MASK = '****';

const normaliseKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// Exact matches after normalisation, so `company` or `span` never trip `pan`.
const IDENTIFIER_KEYS = new Set([
  'accountnumber', 'accountno', 'acctno', 'bankaccount', 'bankaccountnumber', 'bankaccountno', 'bankn', 'iban',
  'ifsc', 'ifsccode', 'bankl',
  'pan', 'panno', 'pannumber', 'vendorpan', 'deducteepan',
  'gstin', 'gstno', 'gstnumber',
  'utr', 'utrcode', 'utrno', 'utrnumber',
]);
const IDENTIFIER_SUFFIX = /(accountnumber|ifsccode|gstin|utrcode|utrnumber)$/;

const isIdentifierKey = (key) => {
  const k = normaliseKey(key);
  return IDENTIFIER_KEYS.has(k) || IDENTIFIER_SUFFIX.test(k);
};

// Broad on purpose for object keys (this is the list the logger always had).
const SECRET_FRAGMENTS = ['password', 'token', 'secret', 'clerk', 'authorization', 'cookie', 'mongo', 'key', 'mongoose', 'db', 'uri'];
const isSecretKey = (key) => {
  const lower = String(key).toLowerCase();
  return SECRET_FRAGMENTS.some((fragment) => lower.includes(fragment));
};

// Narrower for names found inside a string, where `keyword=` or `?uri=` in a
// URL should not blank the value.
const SECRET_NAME_IN_TEXT = /^(pass(word)?|token|secret|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i;

const mask = (value) => {
  const text = String(value).trim();
  if (text.startsWith(MASK)) return text; // already masked: idempotent
  // Showing four characters of a six-character value shows most of it.
  return text.length < 2 * TAIL ? MASK : `${MASK}${text.slice(-TAIL)}`;
};

// Fixed-format identifiers. GSTIN first: it contains a PAN.
const PATTERNS = [
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, // GSTIN
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, // IFSC
];

const JSON_PAIR = /"([A-Za-z0-9_-]+)"(\s*:\s*)(?:"([^"\\]*)"|(\d{5,}))/g;
const QUERY_PAIR = /([?&])([A-Za-z0-9_-]+)=([^&#\s]*)/g;

const decoded = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};

const redactString = (text) => {
  if (typeof text !== 'string' || text === '') return text;

  let out = text.replace(JSON_PAIR, (whole, key, sep, quoted, bare) => {
    if (isIdentifierKey(key)) return `"${key}"${sep}"${mask(quoted ?? bare)}"`;
    if (SECRET_NAME_IN_TEXT.test(key)) return `"${key}"${sep}"[REDACTED]"`;
    return whole;
  });

  out = out.replace(QUERY_PAIR, (whole, lead, key, value) => {
    if (isIdentifierKey(key)) return `${lead}${key}=${mask(decoded(value))}`;
    if (SECRET_NAME_IN_TEXT.test(key)) return `${lead}${key}=[REDACTED]`;
    return whole;
  });

  for (const pattern of PATTERNS) out = out.replace(pattern, (match) => mask(match));
  return out;
};

const isPlainObject = (value) => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * A deep copy of `value` that is safe to write to a log. Never mutates its
 * input; tolerates cycles; leaves dates, decimals and buffers as they are.
 */
const redactDeep = (value, seen = new WeakSet()) => {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: redactString(value.stack) };
  }

  if (seen.has(value)) return '[Circular]';

  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((item) => redactDeep(item, seen));
    seen.delete(value);
    return copy;
  }

  if (!isPlainObject(value)) return value;

  seen.add(value);
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (isSecretKey(key)) {
      out[key] = '[REDACTED]';
    } else if (isIdentifierKey(key)) {
      if (inner !== null && typeof inner === 'object') out[key] = '[REDACTED]';
      else out[key] = inner === null || inner === undefined || inner === '' ? inner : mask(inner);
    } else {
      out[key] = redactDeep(inner, seen);
    }
  }
  seen.delete(value);
  return out;
};

module.exports = { redactDeep, redactString, mask };
