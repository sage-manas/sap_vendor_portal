'use client';

import { useEffect, useState } from 'react';
import { apiClient } from './api-client';

// SAP field limits and the unit-of-measure catalogue, read from the server
// registry (backend/sap/mappings/fields.js via GET /meta/sap-fields) instead
// of a second, driftable copy here — same pattern as /workspace/settings and
// src/lib/whoami.js. Public endpoint, no auth needed, so it is fetched once
// and cached at module scope for every form on the page.
//
// SAP_FIELD_KEYS names the fields the backend registry declares —
// sapFields.test.js checks this list against the real module via
// createRequire, so a renamed/removed field fails CI instead of quietly
// breaking a form's maxLength.
export const SAP_FIELD_KEYS = ['LIFNR', 'MATNR', 'EBELN', 'TXZ01', 'MEINS', 'WAERS'];

let pending = null;

const fetchSapFields = () => {
  if (!pending) pending = apiClient.get('/meta/sap-fields').catch(() => null);
  return pending;
};

/**
 * `{ fields, units, loading }`. `fields` is `{ MATNR: { max, label }, ... }`
 * and `units` is `[{ value, label }, ...]` for a unit dropdown — both empty
 * until the fetch resolves, so a form should fall back to no maxLength /
 * free-text rather than block rendering on this.
 */
export function useSapFields() {
  const [state, setState] = useState({ fields: {}, units: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    fetchSapFields().then((answer) => {
      if (cancelled) return;
      setState({ fields: answer?.fields || {}, units: answer?.units || [], loading: false });
    });
    return () => { cancelled = true; };
  }, []);

  return state;
}
