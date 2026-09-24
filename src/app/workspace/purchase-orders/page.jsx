'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { poService } from '@/features/purchase-order/services/poService';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import { hasPendingInvoicePlanChange } from '@/features/purchase-order/poKind';

// Every purchase order this workspace has raised, across every supplier —
// the buyer/finance/client_admin view of what suppliers/[id]'s "Recent
// purchase orders" table only shows one row of at a time.
//
// A material order is SAP's own document: it is read from SAP or awarded from
// an RFQ here and exported for a buyer's MM team, never created in SAP by this
// application (PROJECT_CONTEXT.md §5.6). The two writes this section owns are
// the invoicing plan on a line (the detail page) and — the one exception, added
// deliberately and scoped to capex — raising an *asset* PO, which SAP creates
// and numbers on submission (ADR-0042, new-asset/page.jsx).

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(Number(value || 0));

const orderValue = (po) => (po.items || []).reduce((sum, item) => sum + Number(item.netValue || 0), 0);

export default function WorkspacePurchaseOrdersPage() {
  const router = useRouter();
  const { can } = useWorkspaceSession();
  const { data, error, loading } = useResource(() => poService.getPOs({ limit: 200 }));
  const pos = data?.pos || [];

  return (
    <>
      <PageHeader title="Purchase Orders" caption="Every order SAP holds for this workspace's suppliers">
        {/* Issue #117: raising capex is the buying organisation's call, and
            finance does not hold po:manage — the button used to render for
            them anyway, so the only place they learned that was a 403 after
            filling in the whole form. Same can() gating every other
            workspace action button already uses (e.g. users/page.jsx's
            Invite button on user:invite). */}
        {can('po:manage') && (
          <button type="button" className="btn btn-v h-9"
            onClick={() => router.push('/workspace/purchase-orders/new-asset')}>
            New asset PO
          </button>
        )}
      </PageHeader>
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
            // A supplier's proposed invoicing-plan change (approved/rejected
            // on the order's own detail page) was previously invisible from
            // here — nothing on this list said one was waiting, so
            // client_admin had no way to find it without already knowing
            // which order to open. Gated the same way the detail page's own
            // approve/reject controls are: po:manage.
            ...(can('po:manage') ? [{
              key: 'invoicePlan',
              header: 'Invoice Plan',
              render: (row) => (hasPendingInvoicePlanChange(row)
                ? <span className="status-badge status-badge-warn">Change Pending</span>
                : null),
            }] : []),
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
