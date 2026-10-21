'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { poService } from '@/features/purchase-order/services/poService';
import { useWorkspaceSession } from '@/lib/workspace-session';
import {
  PageHeader, Notice, Status, Table, Loading, ListFilters, useResource, formatDate,
} from '@/components/console/primitives';
import { useListQuery } from '@/components/console/useListQuery';
import { hasPendingInvoicePlanChange } from '@/features/purchase-order/poKind';
import { formatMoney } from '@/lib/money';

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

const orderValue = (po) => (po.items || []).reduce((sum, item) => sum + Number(item.netValue || 0), 0);

const PAGE_SIZE = 50;

// `view:open` is PO_AWAITING_SUPPLIER in the backend's status registry — the
// same group the overview's "Purchase orders open" tile counts, which is why
// that tile can link here and still mean its own number. The rest are literal
// PoStatus values.
const SHOW = [
  { value: 'view:open', label: 'Open' },
  { value: 'status:Acknowledged', label: 'Acknowledged' },
  { value: 'status:Dispatched', label: 'Dispatched' },
  { value: 'status:Delivered', label: 'Delivered' },
  { value: 'status:Invoiced', label: 'Invoiced' },
  { value: 'status:Paid', label: 'Paid' },
];

export default function WorkspacePurchaseOrdersPage() {
  const router = useRouter();
  const { can } = useWorkspaceSession();
  const query = useListQuery({
    pageSize: PAGE_SIZE,
    filterKeys: ['view', 'status', 'from', 'to', 'vendorId'],
  });
  const { data, error, loading } = useResource(() => poService.getPOs(query.params), query.key);
  const pos = data?.pos || [];

  return (
    <>
      <PageHeader title="Purchase orders" caption="Every order SAP holds for this workspace's suppliers">
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

      <ListFilters query={query} show={SHOW} dateLabel="Raised" />

      {loading ? (
        <Loading label="Loading purchase orders" />
      ) : (
        <Table
          columns={[
            { key: 'id', header: 'Order', render: (row) => <span className="mono">{row.sapPoNumber || row.id}</span> },
            // Finding 4.3: this column used to render `vendorId`, the
            // portal's internal supplier key — so a tenant-wide list of
            // orders was identified by a string nobody in the buying
            // organisation can resolve to a company. The code stays visible
            // underneath, because it is what SAP and the detail route key on,
            // and it falls back to being the only thing shown for an order
            // discovered against a LIFNR this tenant never onboarded (where
            // the API answers vendorName: null rather than guessing).
            {
              key: 'vendorName',
              header: 'Supplier',
              render: (row) => (row.vendorName ? (
                <span className="flex flex-col">
                  <span>{row.vendorName}</span>
                  <span className="mono text-xs text-fg-subtle">{row.vendorId}</span>
                </span>
              ) : <span className="mono">{row.vendorId}</span>),
            },
            { key: 'lines', header: 'Lines', align: 'right', render: (row) => (row.items || []).length },
            { key: 'value', header: 'Value', align: 'right', render: (row) => <span className="mono">{formatMoney(orderValue(row), row.currency)}</span> },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            // A supplier's proposed invoicing-plan change (approved/rejected
            // on the order's own detail page) was previously invisible from
            // here — nothing on this list said one was waiting, so
            // client_admin had no way to find it without already knowing
            // which order to open. Gated the same way the detail page's own
            // approve/reject controls are: po:manage.
            ...(can('po:manage') ? [{
              key: 'invoicePlan',
              header: 'Invoicing plan',
              render: (row) => (hasPendingInvoicePlanChange(row)
                ? <span className="status-badge status-badge-warn">Change Pending</span>
                : null),
            }] : []),
            { key: 'createdDate', header: 'Raised', render: (row) => <span className="whitespace-nowrap">{formatDate(row.createdDate)}</span> },
          ]}
          rows={pos.map((po) => ({ ...po, key: po.id }))}
          rowLabel={(row) => row.sapPoNumber || row.id}
          onRowClick={(row) => router.push(`/workspace/purchase-orders/${row.id}`)}
          empty={query.active ? 'No purchase orders match these filters.' : 'No purchase orders yet.'}
          pagination={{
            page: query.page,
            pageSize: PAGE_SIZE,
            total: data?.pagination?.total ?? pos.length,
            onPageChange: query.setPage,
            noun: 'orders',
          }}
        />
      )}
    </>
  );
}
