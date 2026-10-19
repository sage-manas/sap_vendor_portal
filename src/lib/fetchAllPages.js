// Reading a whole list endpoint, honestly.
//
// Issue #280. Every supplier-side hook called its list endpoint with no
// `limit`, so each one held the server's default page — twenty rows — and
// the screens then computed totals, charts and CSV exports over whatever
// happened to be in it. A supplier with twenty-one invoices read figures
// covering twenty of them, with nothing saying so, and the older documents
// were unreachable: the tables paginate client-side over the page they were
// given.
//
// Headline figures no longer come from these arrays at all — they come from
// GET /api/dashboard/summary, counted in the database. This exists for what
// genuinely needs the rows themselves: the invoice-ageing and ledger tables,
// and the document lists.
//
// Interim by design. The right shape for a table is server pagination —
// `page`/`limit` with the server's `pagination.total` rendered — which is
// issue #280's option (a) and a change to four large views. This is option
// (b) from the same plan: ask for every page, up to a ceiling, and say so
// when the ceiling is hit rather than silently truncating the way the single
// unbounded page did.

// The API refuses a larger one (backend/validators/pagination.validator.js).
export const PAGE_LIMIT = 200;

// 20 pages of 200 is 4,000 documents of one kind for one supplier. Past that
// the browser is the wrong place for this and `truncated` says so, which is
// the part the bug was missing: the old code could not tell a complete list
// from a first page.
export const MAX_PAGES = 20;

/**
 * Pages through a list endpoint and concatenates the rows.
 *
 * @param {(params: {page: number, limit: number}) => Promise<object|null>} fetchPage
 * @param {string} key  the array's property name in the response ('pos', 'invoices', …)
 * @returns {Promise<{rows: any[], total: number, truncated: boolean}|null>}
 *          null when the first page could not be read at all — which the
 *          caller must not confuse with an empty list (issue #111).
 */
export async function fetchAllPages(fetchPage, key, { limit = PAGE_LIMIT, maxPages = MAX_PAGES } = {}) {
  const first = await fetchPage({ page: 1, limit });
  // apiClient answers null for a connectivity error, and the services map
  // every other rejection to null too.
  if (!first) return null;

  const rows = Array.isArray(first) ? [...first] : [...(first[key] || [])];
  // A response with no pagination block is already the whole list (some
  // endpoints predate pagination), so one page is the answer.
  const pages = first.pagination?.pages ?? 1;
  const total = first.pagination?.total ?? rows.length;
  const lastPage = Math.min(pages, maxPages);

  for (let page = 2; page <= lastPage; page++) {
    const next = await fetchPage({ page, limit });
    // One failed page mid-way: return what was read, flagged incomplete.
    // Silently returning it as the full set is the bug this file is about.
    if (!next) return { rows, total, truncated: true };
    rows.push(...(Array.isArray(next) ? next : (next[key] || [])));
  }

  return { rows, total, truncated: pages > lastPage };
}
