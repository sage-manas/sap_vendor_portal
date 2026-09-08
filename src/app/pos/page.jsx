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
    setActiveTab,
    invoiceHook
  } = usePortal();

  return (
    <PurchaseOrdersView
      state={state}
      selectedPoId={selectedPoId}
      setSelectedPoId={setSelectedPoId}
      asnForm={asnForm}
      setAsnForm={setAsnForm}
      handleAsnSubmit={handleAsnSubmit}
      acknowledgePO={poHook.acknowledgePO}
      setActiveTab={setActiveTab}
      submitInvoice={invoiceHook.submitInvoice}
    />
  );
}
