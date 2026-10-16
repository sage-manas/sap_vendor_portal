'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { apiClient } from './api-client';
import { currentSlug } from './workspace-slug';

// "Whose front door is this?" — the question every signed-out screen has to
// answer before it can name a company, show a logo, or decide whether the
// register link exists. The server decides it, from the hostname (subdomain
// tenancy) or from the `?workspace=` link (account tenancy, ADR-0044); the
// browser only reads the answer.
//
// Cached at module scope the way whoami.js is: the sign-in page, the sign-up
// page and the portal shell all ask, and one request serves them. The cache is
// per slug, so a slug that arrives later (a sign-in that remembers one) asks
// again rather than serving the answer for no workspace at all.

let pending = null;
let pendingSlug;

const NO_ANSWER = { workspace: null, required: true, tenancy: null };

const realm = (slug) => {
  if (!pending || pendingSlug !== slug) {
    pendingSlug = slug;
    pending = apiClient
      .get(slug ? `/auth/workspace?workspace=${encodeURIComponent(slug)}` : '/auth/workspace')
      .then((answer) => ({
        workspace: answer?.workspace || null,
        // No workspace resolved, whichever tenancy answered: the screen cannot
        // offer registration, and should say how to get to it. The unbranded
        // state has to mean "this screen names no workspace" — never "a
        // workspace you cannot see" (#255), so this does not depend on the
        // mode. Under account tenancy it is a missing link; under subdomain
        // tenancy an address no tenant owns. Either way there is nowhere to
        // register, and the server refuses the POST (#254).
        required: !answer?.workspace,
        tenancy: answer?.tenancy || null,
      }))
      // A 404 is a real answer: this address belongs to no live workspace.
      .catch(() => NO_ANSWER);
  }
  return pending;
};

export const forgetWorkspaceRealm = () => { pending = null; };

/**
 * The tenant this address belongs to, or `null` while the answer is in flight
 * and for an address no workspace owns. `known` separates the two, so a screen
 * can hold its branding back rather than flashing the default one.
 */
export function useWorkspaceRealm() {
  const pathname = usePathname();
  const [state, setState] = useState({ workspace: null, known: false, required: false, tenancy: null, slug: null });

  // Re-asked on every route change: the shell outlives the sign-in screen, and a
  // sign-in is what teaches it which tenant it is now branded for.
  useEffect(() => {
    let cancelled = false;
    const slug = currentSlug();
    realm(slug).then(({ workspace, required, tenancy }) => {
      if (!cancelled) setState({ workspace, known: true, required, tenancy, slug });
    });
    return () => { cancelled = true; };
  }, [pathname]);

  return {
    workspace: state.workspace,
    known: state.known,
    slug: state.slug,
    companyName: state.workspace?.companyName || null,
    branding: state.workspace?.branding || null,
    workspaceRequired: state.required,
    tenancy: state.tenancy,
    // Absent an answer, assume the door is open: the API is the enforcement
    // point, and hiding the link on a slow request would be the worse failure.
    selfRegistrationOpen: state.required
      ? false
      : state.workspace
        ? Boolean(state.workspace.features?.supplierSelfRegistration)
        : true,
  };
}
