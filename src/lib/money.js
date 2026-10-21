// The one place the portal turns money into text.
//
// Issue #285: four staff pages formatted with `maximumFractionDigits: 0`, so
// ₹1,234.56 read as ₹1,235 on the screens finance reconciles from, while the
// same invoice showed its paise everywhere else. Amounts arrive from the API
// as Decimal strings (backend/utils/money.js), so every entry point coerces.
//
// Paise are never optional in a table or a detail view. If a number has to be
// shortened to fit — a KPI tile, a chart axis — use `formatMoneyCompact`, and
// keep the exact figure within reach in the table beside it.

const toNumber = (value) => Number(value) || 0;

const FRACTION = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

const formatters = new Map();

const formatterFor = (currency) => {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency, ...FRACTION });
    formatters.set(currency, formatter);
  }
  return formatter;
};

/** `₹1,234.56` — the symbol and the paise, always. */
export const formatMoney = (value, currency = 'INR') => formatterFor(currency).format(toNumber(value));

/**
 * `1,234.56` — the same number without a symbol, for a column whose header
 * already carries one ("Gross (₹)"). Not for mixed-currency data.
 */
export const formatAmount = (value) => toNumber(value).toLocaleString('en-IN', FRACTION);

/**
 * `₹45K` · `₹1.2L` · `₹3.4Cr` — Indian units, rounded, for chart axis ticks
 * and KPI tiles only. Never in a table or a detail view: it drops paise and
 * then some.
 */
export const formatMoneyCompact = (value) => {
  const n = toNumber(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e7) return `${sign}₹${+(abs / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${+(abs / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${sign}₹${+(abs / 1e3).toFixed(0)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
};
