// The SAP tax-code registry (issue #66) — the single source of truth for
// which SAP condition-record tax code (G1..G4, the codes this sandbox's own
// data already uses) corresponds to which GST rate, replacing what used to
// be a four-branch `gstToTaxCode` function inline in
// controllers/rfq.controller.js. Same reasoning as config/statuses.js: a
// mapping written inline drifts from every other place that needs the same
// answer, and controllers/reports.controller.js's invoice PDF needs the
// reverse lookup (code -> rate/label) that an inline function never offered
// at all.
//
// Real SAP systems configure this per company code (FTXP) — different
// tenants can legitimately use different tax-code schemes. This registry is
// the fallback used when a tenant hasn't configured its own (nothing does
// yet; config/tenantSettings.js is where a future per-tenant override would
// live, the same way sapVendorCreate settings already override a shared
// default there), so replacing a four-branch function with a shared list is
// the fix this issue actually asks for without inventing a settings screen
// nothing yet reads.
const GST_CODES = [
  { code: 'G1', rate: 18, label: 'GST 18%' },
  { code: 'G2', rate: 12, label: 'GST 12%' },
  { code: 'G3', rate: 5, label: 'GST 5%' },
  { code: 'G4', rate: 28, label: 'GST 28%' },
  { code: 'G5', rate: 0, label: 'GST 0% (Nil-rated)' },
  { code: 'G6', rate: 0, label: 'GST Exempt' },
];

const DEFAULT_GST_CODE = 'G1';

const CODE_BY_RATE = new Map(GST_CODES.map((entry) => [entry.rate, entry.code]));
const ENTRY_BY_CODE = new Map(GST_CODES.map((entry) => [entry.code, entry]));

// A supplier states their GST rate as a rate ("18", "18%", 18) at bid time —
// this is what used to be the inline four-branch function. An unrecognised
// rate still needs a code to file the SAP simulation payload against, so it
// falls back to the registry's default rather than throwing on, say, a
// genuinely valid but uncommon rate (3% on some precious-metal categories)
// this list hasn't been told about yet.
const gstRateToCode = (rate) => {
  const clean = Number(String(rate).replace(/[^0-9.]/g, ''));
  return CODE_BY_RATE.get(clean) || DEFAULT_GST_CODE;
};

// The reverse lookup — a tax code's own rate, for anything (the invoice PDF,
// a derived-tax computation reading a legacy invoice with no per-line
// gstRate yet) that only has the code and needs the percentage it names.
// Returns null for an unknown code rather than guessing a rate.
const gstCodeToRate = (code) => ENTRY_BY_CODE.get(code)?.rate ?? null;

module.exports = { GST_CODES, DEFAULT_GST_CODE, gstRateToCode, gstCodeToRate };
