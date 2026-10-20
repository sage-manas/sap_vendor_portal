'use client';

import { useCallback, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

// Page and filters for a server-paginated list screen (issue #281).
//
// The four workspace lists each asked for a fixed `limit: 200` and rendered
// the answer, so past 200 rows finance saw an incomplete list with nothing
// saying so. Paging is the fix, and all four need the same three things: a
// page, a bag of filters, and a querystring to hand the service and to key
// useResource on. Four copies of that is four places for the reset-page-on-
// filter-change bug to live in three of them.
//
// State, not the URL, is what renders. The URL is read once, for the initial
// state — which is what makes a KPI tile's `?view=open` land pre-filtered —
// and written back on every change, so the screen a reader is looking at is
// the screen a bookmark or a pasted link reproduces. Reading it on every
// render instead would make the page depend on the router actually applying a
// `replace`, which is a thing the real router does asynchronously.

/**
 * @param {object}   options
 * @param {number}   options.pageSize   rows per request; the API's ceiling is
 *                                      200 (backend/validators/pagination.validator.js)
 * @param {string[]} options.filterKeys the query params this screen offers
 * @returns {{
 *   page: number, setPage: (page: number) => void,
 *   filters: Record<string, string>,
 *   setFilter: (key: string, value: string) => void,
 *   clearFilters: () => void,
 *   active: boolean,
 *   params: Record<string, string|number>,
 *   key: string,
 * }}
 */
export const useListQuery = ({ pageSize = 50, filterKeys = [] } = {}) => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Read once. A later render must not reset what the reader has since
  // changed, so this is an initialiser, not a derived value.
  const [state, setState] = useState(() => {
    const filters = {};
    for (const filterKey of filterKeys) filters[filterKey] = searchParams?.get(filterKey) || '';
    const page = Number(searchParams?.get('page')) || 1;
    return { page: page >= 1 ? page : 1, filters };
  });

  const syncUrl = useCallback((next) => {
    const query = new URLSearchParams();
    for (const [filterKey, value] of Object.entries(next.filters)) {
      if (value) query.set(filterKey, value);
    }
    if (next.page > 1) query.set('page', String(next.page));
    const qs = query.toString();
    // `replace`, not `push`: paging a table is not a destination, and a reader
    // who pages to 7 and then presses Back wants the screen they came from,
    // not pages 6, 5, 4 …
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname]);

  const setPage = useCallback((page) => {
    setState((prev) => {
      const next = { ...prev, page: Math.max(1, page) };
      syncUrl(next);
      return next;
    });
  }, [syncUrl]);

  const setFilter = useCallback((filterKey, value) => {
    setState((prev) => {
      // Back to page 1: page 7 of the old filter is very likely past the end
      // of the new one, and an empty table is not an answer to a filter the
      // reader just applied.
      const next = { page: 1, filters: { ...prev.filters, [filterKey]: value || '' } };
      syncUrl(next);
      return next;
    });
  }, [syncUrl]);

  const clearFilters = useCallback(() => {
    setState(() => {
      const filters = {};
      for (const filterKey of filterKeys) filters[filterKey] = '';
      const next = { page: 1, filters };
      syncUrl(next);
      return next;
    });
    // filterKeys is a literal at every call site; listing it would re-create
    // this callback on every render for no gain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncUrl]);

  const { page, filters } = state;

  const params = useMemo(() => {
    const next = { page, limit: pageSize };
    for (const [filterKey, value] of Object.entries(filters)) {
      if (value) next[filterKey] = value;
    }
    return next;
  }, [page, pageSize, filters]);

  return {
    page,
    setPage,
    filters,
    setFilter,
    clearFilters,
    /** Whether any filter is set — for showing a "Clear" control, and only then. */
    active: Object.values(filters).some(Boolean),
    params,
    /** What useResource keys on: changes exactly when the request changes. */
    key: new URLSearchParams(params).toString(),
  };
};
