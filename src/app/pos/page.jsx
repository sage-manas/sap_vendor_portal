'use client';

import React from 'react';
import { usePortal } from '@/lib/portal-context';
import PurchaseOrdersView from '@/features/purchase-order/components/PurchaseOrdersView';

export default function PurchaseOrdersPage() {
  const {
    state,
    selectedPoId,
    setSelectedPoId,
    poHook
  } = usePortal();

  return (
    <PurchaseOrdersView
      state={state}
      selectedPoId={selectedPoId}
      setSelectedPoId={setSelectedPoId}
      acknowledgePO={poHook.acknowledgePO}
      retrySapStatus={poHook.refreshSapPoStatus}
    />
  );
}
