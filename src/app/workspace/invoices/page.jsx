'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { invoiceService } from '@/features/billing/services/invoiceService';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// Every invoice submitted against this workspace's purchase orders, across
// every supplier — the finance (and client_admin) tenant-wide view. GET
// /api/invoices already returns every vendor's invoices to tenant staff with
// no vendorId filter (see backend/tests/tenant-wide-visibility.test.js).
//
// Read-only: MIRO posting is AP's own transaction in SAP, not something this
// portal performs (see PROJECT_CONTEXT.md §5.6) — a row here is what to
// reconcile against SAP, not something to act on from this screen. A row
// links through to the supplier it belongs to, since that is where the
// fuller trading history (payments, TDS, GRNs) already lives.

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(Number(value || 0));

export default function WorkspaceInvoicesPage() {
  const router = useRouter();
  const { data, error, loading } = useResource(() => invoiceService.getInvoices({ limit: 200 }));
  const invoices = data?.invoices || [];

  return (
    <>
      <PageHeader title="Invoices" caption="Every invoice submitted against this workspace's orders, across every supplier" />
      <Notice tone="error">{error}</Notice>

      {loading ? (
        <Loading label="Loading invoices" />
      ) : (
        <Table
          columns={[
            { key: 'invoiceNumber', header: 'Invoice', render: (row) => <span className="mono">{row.invoiceNumber || row.id}</span> },
            { key: 'vendorId', header: 'Supplier' },
            { key: 'poId', header: 'Order', render: (row) => <span className="mono">{row.poId}</span> },
            { key: 'totalAmount', header: 'Amount', render: (row) => <span className="mono">{money(row.totalAmount, row.currency)}</span> },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            { key: 'invoiceDate', header: 'Invoiced', render: (row) => <span className="mono text-[11px]">{formatDate(row.invoiceDate)}</span> },
          ]}
          rows={invoices.map((invoice) => ({ ...invoice, key: invoice.id }))}
          onRowClick={(row) => router.push(`/workspace/suppliers/${row.vendorId}`)}
          empty="No invoices submitted yet."
        />
      )}
    </>
  );
}
