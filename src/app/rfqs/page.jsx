'use client';

import React from 'react';
import { usePortal } from '@/lib/portal-context';
import RfqView from '@/features/rfq/components/RfqView';

export default function RfqsPage() {
  const {
    state,
    selectedRfqId,
    setSelectedRfqId,
    handleBidSubmit,
    handleSapQuotePriceUpdate,
    addToast
  } = usePortal();

  return (
    <RfqView
      state={state}
      selectedRfqId={selectedRfqId}
      setSelectedRfqId={setSelectedRfqId}
      handleBidSubmit={handleBidSubmit}
      handleSapQuotePriceUpdate={handleSapQuotePriceUpdate}
      addToast={addToast}
    />
  );
}
