// Query-string filters for the tenant list endpoints.
//
// Issue #281. The workspace lists are tenant-wide — every supplier's invoices,
// orders, payments and RFQs in one table — so they are the screens that
// actually need narrowing, and they are what the overview's KPI tiles link to.
// A tile that counts 38 invoices not yet cleared and opens a list of 4,000 has
// not answered the question the reader clicked on.
//
// Filtering happens here, not in the browser, for the same reason the figures
// moved to the database in #280: a client-side filter can only narrow the page
// it was given, so it reports a subset of a subset and calls it a count.
//
// `page`/`limit` are not this file's business — validators/pagination.validator.js
// coerces and bounds those before any controller runs.

const { INVOICE_OPEN, PO_AWAITING_SUPPLIER } = require('../config/statuses');

/**
 * `?status=` as a Prisma filter. A comma-separated list becomes an `in`, so a
 * caller can ask for the two or three states it is interested in without
 * three round trips.
 */
const statusFilter = (value) => {
  if (!value) return null;
  const statuses = String(value).split(',').map((status) => status.trim()).filter(Boolean);
  if (statuses.length === 0) return null;
  return statuses.length === 1 ? statuses[0] : { in: statuses };
};

// `?view=` — a named status group, kept separate from `?status=` rather than
// overloading it, because 'open' is also a literal PoStatus value and
// `?status=open` would then mean two different things on two lists.
//
// The groups come from the status registry, which is what the overview's own
// counts read (config/statuses.js) — so "Invoices not yet cleared: 38" and the
// list behind it are the same query, and a status moving between groups moves
// in both places at once.
const VIEWS = {
  invoice: { open: { in: INVOICE_OPEN } },
  po: { open: { in: PO_AWAITING_SUPPLIER } },
};

/**
 * The `status` filter for a resource, from `?view=` or `?status=`.
 *
 * `view` wins when both are given: it is the narrower, named intent (a tile
 * the reader clicked), and silently intersecting two status filters would
 * produce an empty list with nothing on screen explaining why.
 *
 * @param resource 'invoice' | 'po' — which set of named views applies
 * @returns a Prisma filter for `status`, or null for no status filter at all
 */
const statusFilterFor = (resource, query = {}) => {
  const view = VIEWS[resource]?.[String(query.view || '').trim()];
  return view || statusFilter(query.status);
};

/**
 * `?from=`/`?to=` as a Prisma filter on whichever column the resource dates
 * itself by — the caller names the field, because an invoice is dated by
 * invoiceDate and a payment by paymentDate.
 *
 * `to` includes the whole day it names. A date-only `to=2026-03-31` parses as
 * midnight, and a reader who filtered "to 31 March" means the 31st, not
 * everything that happened before it began.
 *
 * An unparseable bound is ignored rather than rejected: it reaches Prisma as
 * `Invalid Date` otherwise, which is a 500 for a typo in a URL.
 */
const dateRangeFilter = (query = {}) => {
  const filter = {};

  const from = query.from ? new Date(query.from) : null;
  if (from && !Number.isNaN(from.valueOf())) filter.gte = from;

  const to = query.to ? new Date(query.to) : null;
  if (to && !Number.isNaN(to.valueOf())) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to).trim());
    filter.lte = dateOnly ? new Date(to.valueOf() + 24 * 3600 * 1000 - 1) : to;
  }

  return Object.keys(filter).length ? filter : null;
};

/**
 * Builds the `where` for a list endpoint on top of the vendor scope the
 * request already carries.
 *
 * @param base     the scoped where (withVendorScope(req)) — never overwritten,
 *                 so a supplier's own vendorId still wins over anything the
 *                 query string says.
 * @param resource 'invoice' | 'po' | null — which named views apply
 * @param dateField the column `?from`/`?to` filter on, if the resource has one
 */
const listWhere = (base, query = {}, { resource = null, dateField = null } = {}) => {
  const where = { ...base };

  const status = statusFilterFor(resource, query);
  if (status) where.status = status;

  const dates = dateField ? dateRangeFilter(query) : null;
  if (dates) where[dateField] = dates;

  // Invoices only, and guarded on the resource rather than on the parameter
  // being present: `totalAmount` is a column on Invoice alone, so an unguarded
  // `?minAmount=` on /payments would reach Prisma as an unknown field and 500.
  // It exists for the overview's "Above the review amount" tile — the one KPI
  // whose count is an amount threshold rather than a status.
  if (resource === 'invoice') {
    const minAmount = Number(query.minAmount);
    if (query.minAmount !== undefined && Number.isFinite(minAmount)) {
      where.totalAmount = { gte: minAmount };
    }
  }

  return where;
};

module.exports = { statusFilter, statusFilterFor, dateRangeFilter, listWhere, VIEWS };
