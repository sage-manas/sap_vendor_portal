'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { poService } from '@/features/purchase-order/services/poService';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// Every purchase order this workspace has raised, across every supplier —
// the buyer/finance/client_admin view of what suppliers/[id]'s "Recent
// purchase orders" table only shows one row of at a time. Read-only: an order
// itself is SAP's document (see PROJECT_CONTEXT.md §5 — the portal creates no
// POs of its own), so the only thing this screen's detail page lets staff
// configure is the invoicing plan on a line, which is the portal's write.

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(Number(value || 0));

const orderValue = (po) => (po.items || []).reduce((sum, item) => sum + Number(item.netValue || 0), 0);

export default function WorkspacePurchaseOrdersPage() {
  const router = useRouter();
  const { data, error, loading } = useResource(() => poService.getPOs({ limit: 200 }));
  const pos = data?.pos || [];

  return (
    <>
      <PageHeader title="Purchase Orders" caption="Every order SAP holds for this workspace's suppliers" />
      <Notice tone="error">{error}</Notice>

      {loading ? (
        <Loading label="Loading purchase orders" />
      ) : (
        <Table
          columns={[
            { key: 'id', header: 'Order', render: (row) => <span className="mono">{row.sapPoNumber || row.id}</span> },
            { key: 'vendorId', header: 'Supplier' },
            { key: 'lines', header: 'Lines', render: (row) => (row.items || []).length },
            { key: 'value', header: 'Value', render: (row) => <span className="mono">{money(orderValue(row), row.currency)}</span> },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            { key: 'createdDate', header: 'Raised', render: (row) => <span className="mono text-[11px]">{formatDate(row.createdDate)}</span> },
          ]}
          rows={pos.map((po) => ({ ...po, key: po.id }))}
          onRowClick={(row) => router.push(`/workspace/purchase-orders/${row.id}`)}
          empty="No purchase orders yet."
        />
      )}
    </>
  );
}
