// Reading a date SAP sent, in whichever of its spellings this endpoint uses.
//
// The Z endpoints do not agree with each other, and sometimes not with
// themselves: zmiro_display/MIRO sends DOC_DATE as "20261001", zpayment_api/
// payment sends DOCUMENT_DATE as "2026-10-01" (and once sent an unset date as a
// bare 00000000), zpo_grn_vendor/Detail sends PO_DATE as "21.09.2026". Callers
// used to pick one and `new Date()` the rest, which turned "20261001" into an
// Invalid Date that Prisma refused (issue #349), and used to fall back to "now"
// when that failed, which recorded a payment on a day nobody paid it.
//
// So this reads every spelling seen live, and answers null for anything else —
// including SAP's unset date — never the current time. What to do without a
// date is the caller's decision, not this helper's.

const YYYYMMDD = /^(\d{4})(\d{2})(\d{2})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const DOTTED = /^(\d{2})\.(\d{2})\.(\d{4})$/;

const utcDay = (year, month, day) => {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Rejects 20261345 and friends, which Date.UTC would quietly roll over.
  return date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) ? date : null;
};

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {Date|null} midnight UTC of the day SAP meant, or null
 */
const parseSapDate = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value ?? '').trim();
  if (!text || /^0+$/.test(text)) return null;

  let parts = YYYYMMDD.exec(text);
  if (parts) return utcDay(parts[1], parts[2], parts[3]);

  parts = DOTTED.exec(text);
  if (parts) return utcDay(parts[3], parts[2], parts[1]);

  if (ISO_DAY.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

/** The same day as `YYYY-MM-DD`, or null — for fields the driver returns as text. */
const sapDateToIso = (value) => {
  const date = parseSapDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
};

module.exports = { parseSapDate, sapDateToIso };
