'use client';

import { useEffect } from 'react';
import { useWorkspaceRealm } from '@/lib/workspace-realm';
import { accentVariables } from '@/lib/branding';

/**
 * Paints the supplier portal in its tenant's accent.
 *
 * The variables go on `<html>` rather than on a wrapper because the console's
 * accented surfaces — focus rings, the sidebar rail, the BAPI console — are not
 * all inside one subtree, and a portal or a dialog rendered elsewhere in the
 * document should still be the tenant's colour. It renders nothing.
 */
export default function TenantBranding() {
  const { branding } = useWorkspaceRealm();

  useEffect(() => {
    const variables = accentVariables(branding?.primaryColor);
    const root = document.documentElement;
    const entries = Object.entries(variables);
    for (const [name, value] of entries) root.style.setProperty(name, value);
    // Removing the inline value hands the colour back to the stylesheet, which
    // is what an unbranded workspace and a signed-out visitor should see.
    return () => { for (const [name] of entries) root.style.removeProperty(name); };
  }, [branding?.primaryColor]);

  return null;
}
