// The Indian fiscal calendar, which is not the calendar year and not the
// calendar quarter.
//
// A financial year runs 1 April to 31 March and is named for both years it
// spans ("2025-26"). TDS is reported and certified per fiscal quarter, and
// those quarters are offset from calendar ones:
//
//   Q1  Apr–Jun     Q2  Jul–Sep     Q3  Oct–Dec     Q4  Jan–Mar
//
// This matters because a TDS registry grouped by calendar quarter puts a
// January payment in the wrong return period, and a supplier reconciling
// against their Form 26AS would find the quarters disagree.

// The year a fiscal year is named for: the calendar year its April fell in.
// January–March belong to the fiscal year that started the previous April.
const fiscalYearOf = (date) => {
  const d = new Date(date);
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
};

// "Q1".."Q4", counted from April.
const fiscalQuarterOf = (date) => {
  const d = new Date(date);
  return `Q${Math.floor(((d.getMonth() + 9) % 12) / 3) + 1}`;
};

// "2025-26", the form a certificate and a 26AS statement both use.
const fiscalYearLabel = (fiscalYear) =>
  `${fiscalYear}-${String((fiscalYear + 1) % 100).padStart(2, '0')}`;

// "Q1 (Apr - Jun)" — the quarter with the months spelled out, because a
// supplier reads these against their own books and "Q1" alone is ambiguous
// when their accounting software counts from January.
const QUARTER_MONTHS = { Q1: 'Apr - Jun', Q2: 'Jul - Sep', Q3: 'Oct - Dec', Q4: 'Jan - Mar' };
const fiscalQuarterLabel = (quarter) =>
  QUARTER_MONTHS[quarter] ? `${quarter} (${QUARTER_MONTHS[quarter]})` : quarter;

// Everything a Payment row needs to be filed into the right return period.
const fiscalPeriodOf = (date) => ({
  fiscalYear: fiscalYearOf(date),
  quarter: fiscalQuarterOf(date),
});

module.exports = {
  fiscalYearOf,
  fiscalQuarterOf,
  fiscalYearLabel,
  fiscalQuarterLabel,
  fiscalPeriodOf,
  QUARTER_MONTHS,
};
