'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { poService } from '@/features/purchase-order/services/poService';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// Every shipment a supplier has dispatched against this workspace's orders —
// the buyer/finance/client_admin tenant-wide view (finding 4.1).
//
// There was no such screen because there could not be: `GET /api/asns` opened
// with `requireVendorScope`, which answers 400 "vendorId is required" to any
// caller that is not a supplier. So the people the goods are inbound to were
// the only ones who could not see what was coming. All three staff roles
// already held `asn:read` (backend/config/permissions.js, TENANT_READ_ONLY) —
// the permission was never the problem.
//
// Read-only, like the orders and invoices lists either side of it. An ASN is
// the supplier's own declaration of what they dispatched; the buyer's counter-
// record is the goods receipt SAP posts in MIGO (PROJECT_CONTEXT.md §5.6),
// which this portal reads and does not write. So nothing here is actionable —
// a row is something to expect, and to reconcile against the GRN when it
// lands.

const dueTone = (asn) => {
  if (!asn.estimatedDeliveryDate) return null;
  // Overdue is worth saying plainly: a shipment past its own estimate with no
  // goods receipt against it is the single thing this screen exists to
  // surface. Deliberately derived from the supplier's stated estimate, not
  // from an SLA nobody agreed.
  const due = new Date(asn.estimatedDeliveryDate);
  if (Number.isNaN(due.getTime())) return null;
  return due < new Date() ? 'overdue' : null;
};

export default function WorkspaceShipmentsPage() {
  const router = useRouter();
  const { data, error, loading } = useResource(() => poService.getASNs({ limit: 200 }));
  const asns = data?.asns || [];

  return (
    <>
      <PageHeader
        title="Shipments"
        caption="What suppliers have dispatched against this workspace's orders, and when it is due"
      />
      <Notice tone="error">{error}</Notice>

      {loading ? (
        <Loading label="Loading shipments" />
      ) : (
        <Table
          columns={[
            { key: 'id', header: 'Shipment', render: (row) => <span className="mono">{row.id}</span> },
            // `vendorName` is what finding 4.3 adds to the tenant-wide lists;
            // until that reaches this endpoint the code is what there is, and
            // showing it is better than showing nothing. No fabrication
            // either way — whichever the API supplies is what renders.
            { key: 'vendorName', header: 'Supplier', render: (row) => row.vendorName || <span className="mono">{row.vendorId}</span> },
            { key: 'poId', header: 'Order', render: (row) => <span className="mono">{row.poId}</span> },
            { key: 'carrierName', header: 'Carrier', render: (row) => row.carrierName || '—' },
            {
              key: 'trackingNumber',
              header: 'Tracking',
              // A supplier is not obliged to give one, and an absent tracking
              // number reads as absent rather than as an empty cell.
              render: (row) => <span className="mono">{row.trackingNumber || '—'}</span>,
            },
            { key: 'shipDate', header: 'Dispatched', render: (row) => <span className="mono text-[11px]">{formatDate(row.shipDate)}</span> },
            {
              key: 'estimatedDeliveryDate',
              header: 'Due',
              render: (row) => (
                <span className={`mono text-[11px] ${dueTone(row) === 'overdue' ? 'text-red-600' : ''}`}>
                  {formatDate(row.estimatedDeliveryDate)}
                  {dueTone(row) === 'overdue' && <span className="ml-1.5 not-italic">(overdue)</span>}
                </span>
              ),
            },
            {
              key: 'sapInboundDelivery',
              header: 'SAP inbound delivery',
              // Null until SAP's own ledger has one — never invented here
              // (PROJECT_CONTEXT.md §5.6, and issue #121 for the frontend
              // half of that rule).
              render: (row) => <span className="mono">{row.sapInboundDelivery || '—'}</span>,
            },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          ]}
          rows={asns.map((asn) => ({ ...asn, key: asn.id }))}
          // Through to the supplier, same as the invoices list — that is where
          // the fuller trading history already lives.
          onRowClick={(row) => router.push(`/workspace/suppliers/${row.vendorId}`)}
          empty="No shipments dispatched yet."
        />
      )}
    </>
  );
}
