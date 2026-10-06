'use client';

import { useEffect, useState } from 'react';
import { apiClient } from './api-client';

// The Indian states and union territories a GST registration can belong to,
// read from the server registry (backend/config/indianStates.js via
// GET /meta/indian-states) rather than a second, driftable copy here — the
// same reasoning as src/lib/sapFields.js and src/lib/whoami.js.
//
// Not merely tidiness here (finding 4.4): services/gst.service.js decides
// CGST+SGST versus IGST by comparing the buyer tenant's state to the
// supplier's as trimmed, lower-cased strings. Two lists that disagree on one
// spelling — '&' against 'and', say — split every invoice between those two
// parties the wrong way, with no error anywhere. One list, served.
//
// Public endpoint, no auth required. That is also what lets the platform
// console use it: the console holds a platform token, not a tenant one, and
// this endpoint asks for neither.
//
// Unlike sapFields.js this deliberately does NOT cache at module scope.
// That cache exists there because several forms on one page want the same
// answer; here one dropdown on one operator-console page does, and caching
// it buys nothing while costing two things. It would hold a *failure*
// forever — `.catch(() => null)` is remembered just as happily as a success,
// so one network blip leaves the dropdown permanently dead with no recovery
// short of a page reload — and it would make the list impossible to re-read
// after the registry changes. A 37-row request when an operator opens a
// tenant is not worth either.
const fetchIndianStates = () => apiClient.get('/meta/indian-states').catch(() => null);

/**
 * `{ states, loading, failed }`. `states` is `[{ code, name }, ...]`.
 *
 * `failed` matters: a state dropdown with no options is indistinguishable
 * from "there are no states to pick", so a caller renders the failure rather
 * than an empty select the operator cannot act on and cannot explain.
 */
export function useIndianStates() {
  const [state, setState] = useState({ states: [], loading: true, failed: false });

  useEffect(() => {
    let cancelled = false;
    fetchIndianStates().then((answer) => {
      if (cancelled) return;
      setState({
        states: answer?.states || [],
        loading: false,
        // A body without `states` is a contract change, not an empty country
        // — the same distinction usePOs.js draws for a missing `orders`.
        failed: !Array.isArray(answer?.states),
      });
    });
    return () => { cancelled = true; };
  }, []);

  return state;
}
