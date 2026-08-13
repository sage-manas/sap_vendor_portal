'use client';

import { useEffect, useState } from 'react';
import { apiClient } from './api-client';

// "Whose front door is this?" — the question every signed-out screen has to
// answer before it can name a company, show a logo, or decide whether the
// register link exists. The hostname decides it server-side; the browser only
// reads the answer.
//
// Cached at module scope the way whoami.js is: the sign-in page, the sign-up
// page and the portal shell all ask, and one request serves them.

let pending = null;

const realm = () => {
  if (!pending) {
    pending = apiClient
      .get('/auth/workspace')
      .then((answer) => answer?.workspace || null)
      // A 404 is a real answer: this hostname belongs to no live workspace.
      .catch(() => null);
  }
  return pending;
};

export const forgetWorkspaceRealm = () => { pending = null; };

/**
 * The tenant this hostname belongs to, or `null` while the answer is in flight
 * and for a hostname no workspace owns. `known` separates the two, so a screen
 * can hold its branding back rather than flashing the default one.
 */
export function useWorkspaceRealm() {
  const [state, setState] = useState({ workspace: null, known: false });

  useEffect(() => {
    let cancelled = false;
    realm().then((workspace) => {
      if (!cancelled) setState({ workspace, known: true });
    });
    return () => { cancelled = true; };
  }, []);

  return {
    workspace: state.workspace,
    known: state.known,
    companyName: state.workspace?.companyName || null,
    branding: state.workspace?.branding || null,
    // Absent an answer, assume the door is open: the API is the enforcement
    // point, and hiding the link on a slow request would be the worse failure.
    selfRegistrationOpen: state.workspace
      ? Boolean(state.workspace.features?.supplierSelfRegistration)
      : true,
  };
}
