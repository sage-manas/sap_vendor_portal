// 10 May 2026 — the app's one display format for a date. Documents arrive
// with ISO timestamps; nobody reads those. A value that does not parse is
// shown as it came, never as "Invalid Date".
//
// Two shapes are *date-only* and must not be read as moments (issue #289):
//
//  - a bare `YYYY-MM-DD`. `new Date('2026-05-10')` is parsed as UTC midnight
//    by spec, so west of Greenwich it renders as the 9th — a date-only field
//    has no timezone to be converted out of, so it is built as local midnight.
//  - SAP's own `YYYYMMDD` (EKKO-BEDAT and friends, via the ME43/ME48 reads),
//    which `new Date()` rejects outright.
//
// Everything else is a real timestamp and is rendered in the reader's local
// time. Splitting the `T` off one instead — what RfqView's own formatDate did
// — reads the UTC calendar day, so anything created before 05:30 IST showed
// the previous day.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const SAP_DATE = /^(\d{4})(\d{2})(\d{2})$/;

const FORMAT = { day: '2-digit', month: 'short', year: 'numeric' };

const render = (date) =>
  (Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-IN', FORMAT));

export const displayDate = (value) => {
  if (!value) return '—';

  const text = String(value);
  const parts = DATE_ONLY.exec(text) || SAP_DATE.exec(text);
  if (parts) {
    const local = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return render(local) ?? text;
  }

  return render(new Date(value)) ?? text;
};
