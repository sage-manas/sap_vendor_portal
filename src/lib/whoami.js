'use client';

import { useEffect, useState } from 'react';
import { apiClient } from './api-client';

// "Who is signed in?", for the parts of the supplier portal's chrome that have
// to know. The workspace layout has a full session provider; the sidebar and
// the command palette need one bit of it — is this a supplier, or is this the
// buying organisation's own staff — and asking through a provider they are not
// inside of would mean lifting state they otherwise have no use for.
//
// The answer is cached at module scope so the two of them share one request,
// and cleared on sign-out by the page reload that follows it.

let pending = null;

const whoami = () => {
  if (!pending) pending = apiClient.get('/auth/me').catch(() => null);
  return pending;
};

export const forgetWhoami = () => { pending = null; };

/**
 * The signed-in principal's plane and permissions, or nulls before the answer
 * arrives and for a signed-out visitor.
 */
export function useWhoami() {
  const [me, setMe] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const token = typeof window !== 'undefined' && localStorage.getItem('jwt_token');
    if (!token) return undefined;

    whoami().then((answer) => { if (!cancelled) setMe(answer); });
    return () => { cancelled = true; };
  }, []);

  return {
    plane: me?.auth?.plane || null,
    role: me?.auth?.role || null,
    permissions: me?.auth?.permissions || [],
    workspace: me?.workspace || null,
    // The back office belongs to the buying organisation, never to a supplier.
    isTenantStaff: me?.auth?.plane === 'tenant',
  };
}
