'use client';

import React from 'react';
import { usePortal } from '@/lib/portal-context';
import InvoiceProcessingView from '@/features/billing/components/InvoiceProcessingView';

export default function InvoicesPage() {
  const { state } = usePortal();

  return <InvoiceProcessingView state={state} />;
}
