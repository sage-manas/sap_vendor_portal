'use client';

import React from 'react';
import { usePortal } from '@/lib/portal-context';
import PurchaseOrdersView from '@/features/purchase-order/components/PurchaseOrdersView';

export default function PurchaseOrdersPage() {
  const {
    state,
    selectedPoId,
    setSelectedPoId,
    asnForm,
    setAsnForm,
    handleAsnSubmit,
    poHook,
    addToast
  } = usePortal();

  // Says so when the acknowledgement could not reach SAP (issue #351), rather
  // than letting the status change imply the buyer's system knows.
  const acknowledgePO = async (poId) => {
    const result = await poHook.acknowledgePO(poId);
    if (result?.success && !result.sapWritten) {
      addToast('info', "Acknowledged in the portal. Your buyer's SAP system was not updated.");
    }
    return result;
  };

  return (
    <PurchaseOrdersView
      state={state}
      selectedPoId={selectedPoId}
      setSelectedPoId={setSelectedPoId}
      asnForm={asnForm}
      setAsnForm={setAsnForm}
      handleAsnSubmit={handleAsnSubmit}
      acknowledgePO={acknowledgePO}
      cancelASN={poHook.cancelASN}
      retrySapStatus={poHook.refreshSapPoStatus}
    />
  );
}
