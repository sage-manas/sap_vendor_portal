'use client';

import React, { Suspense } from 'react';
import AsnView from '@/features/asn/components/AsnView';

// useSearchParams (the view to show) needs a Suspense boundary for the
// page to build statically.
export default function AsnPage() {
  return (
    <Suspense fallback={null}>
      <AsnView />
    </Suspense>
  );
}
