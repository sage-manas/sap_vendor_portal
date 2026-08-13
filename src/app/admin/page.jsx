'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

// The single-company admin console became the tenant workspace in Phase 5.
// Its three tabs each grew into a screen of their own — the systems dashboard
// into /workspace, the compliance queue into /workspace/suppliers, and the
// interface log into the supplier portal's own SAP log view — so this route
// exists only to carry an old bookmark across.
export default function AdminRedirectPage() {
  const router = useRouter();

  React.useEffect(() => {
    router.replace('/workspace');
  }, [router]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="size-5 animate-spin text-text-tertiary" />
    </div>
  );
}
