'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { poService } from '@/features/purchase-order/services/poService';
import { PageHeader, Notice, Status, Table, Loading, Field, useResource, formatDate } from '@/components/console/primitives';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';
import { Button } from '@/components/ui/button';
import { useWorkspaceSession } from '@/lib/workspace-session';
import RejectShipmentDialog from '@/features/asn/components/RejectShipmentDialog';

// The buying organisation's shipments: the ASN monitor (ASN design screen B1)
// above, every shipment below.
//
// The monitor answers the four questions a plant asks each morning, for one
// plant (or all) and one day, defaulting to the tenant's own today:
//   - what is expected,
//   - what is waiting for the tenant admin's approval,
//   - what SAP has not taken (with SAP's reason, and a retry),
//   - what is late: past its expected date and not received.
// Approve, reject and retry are the tenant admin's (asn:approve); every staff
// role sees the same screen without them.
//
// An ASN is the supplier's own declaration of what they dispatched; the
// buyer's counter-record is the goods receipt SAP posts in MIGO
// (PROJECT_CONTEXT.md §5.6), which this portal reads and does not write.
// "At gate" joins the monitor once SAP reports gate-in (the status endpoint in
// docs/abap-requests/inbound-delivery.md); nothing here claims it before then.

const dueTone = (asn) => {
  if (!asn.estimatedDeliveryDate) return null;
  // Derived from the supplier's stated estimate, not from an SLA nobody agreed.
  const due = new Date(asn.estimatedDeliveryDate);
  if (Number.isNaN(due.getTime())) return null;
  return due < new Date() ? 'overdue' : null;
};

const ordersOf = (asn) => [...new Set([asn.poId, ...(asn.items || []).map((item) => item.poId)].filter(Boolean))].join(', ');
const totalQty = (asn) => (asn.items || []).reduce((sum, item) => sum + (Number(item.shippedQuantity) || 0), 0);

const baseColumns = [
  { key: 'id', header: 'Shipment', render: (row) => <span className="mono">{row.id}</span> },
  { key: 'vendorName', header: 'Supplier', render: (row) => row.vendorName || <span className="mono">{row.vendorId}</span> },
  { key: 'orders', header: 'Orders', render: (row) => <span className="mono">{ordersOf(row)}</span> },
  { key: 'plant', header: 'Plant', render: (row) => row.plant || '—' },
  { key: 'qty', header: 'Qty', align: 'right', render: (row) => <span className="mono">{totalQty(row)}</span> },
  { key: 'vehicle', header: 'Vehicle', render: (row) => <span className="mono">{row.vehicleNumber || row.trackingNumber || '—'}</span> },
  { key: 'eta', header: 'Expected', render: (row) => <span className="whitespace-nowrap">{formatDate(row.estimatedDeliveryDate)}{row.arrivalTime ? ` ${row.arrivalTime}` : ''}</span> },
];

function Section({ title, caption, rows, columns, empty }) {
  return (
    <section aria-label={title} className="mb-8">
      <h2 className="text-lg font-semibold text-fg">{title} <span className="text-sm font-normal text-fg-subtle">({rows.length})</span></h2>
      {caption && <p className="mb-3 text-sm text-fg-muted">{caption}</p>}
      <Table columns={columns} rows={rows.map((row) => ({ ...row, key: row.id }))} rowLabel={(row) => row.id} empty={empty} />
    </section>
  );
}

export default function WorkspaceShipmentsPage() {
  const router = useRouter();
  const { can } = useWorkspaceSession();
  const canDecide = can('asn:approve');

  const [plant, setPlant] = useState('');
  const [date, setDate] = useState('');
  const query = new URLSearchParams({ ...(plant ? { plant } : {}), ...(date ? { date } : {}) }).toString();
  const monitor = useResource(() => poService.getAsnMonitor(query), query);
  const all = useResource(() => poService.getASNs({ limit: 200 }));
  const m = monitor.data || { expected: [], pendingApproval: [], sapErrors: [], overdue: [], plants: [] };
  const asns = all.data?.asns || [];

  const [rejecting, setRejecting] = useState(null);
  const [busy, setBusy] = useState(null);
  const reloadBoth = () => { monitor.reload(); all.reload(); };
  const act = async (asn, fn, failure) => {
    setBusy(asn.id);
    try {
      await fn();
      reloadBoth();
    } catch (err) {
      monitor.setError(err?.message || failure);
    } finally {
      setBusy(null);
    }
  };

  // Header-less columns are row actions (console Table), kept from opening
  // the supplier's page underneath.
  const action = (render) => ({
    key: 'actions',
    render: (row) => <span className="flex gap-2" onClick={(e) => e.stopPropagation()} role="presentation">{render(row)}</span>,
  });

  const approvalColumns = [
    ...baseColumns,
    { key: 'submittedAt', header: 'Sent', render: (row) => <span className="whitespace-nowrap">{formatDate(row.submittedAt)}</span> },
    ...(canDecide ? [action((row) => (
      <>
        <Button size="sm" onClick={() => act(row, () => poService.approveShipment(row.id), 'The shipment could not be approved.')} disabled={busy === row.id}>Approve</Button>
        <Button size="sm" variant="secondary" onClick={() => setRejecting(row)} disabled={busy === row.id}>Reject</Button>
      </>
    ))] : []),
  ];

  const errorColumns = [
    ...baseColumns.slice(0, 4),
    { key: 'sapError', header: 'What SAP said', render: (row) => <span className="text-danger">{row.sapError}</span> },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    ...(canDecide ? [action((row) => (
      <Button size="sm" variant="secondary" onClick={() => act(row, () => poService.retryShipmentSap(row.id), 'SAP could not be asked again.')} disabled={busy === row.id}>Retry</Button>
    ))] : []),
  ];

  const trackingColumns = [
    ...baseColumns,
    { key: 'sapInboundDelivery', header: 'SAP delivery', render: (row) => <span className="mono">{row.sapInboundDelivery || '—'}</span> },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
  ];

  const dayLabel = m.date && m.date === m.today ? 'today' : `on ${formatDate(m.date)}`;

  return (
    <>
      <PageHeader
        title="Shipments"
        caption="What suppliers have dispatched against this workspace's orders, and what each plant should expect"
      />
      <Notice tone="error">{monitor.error || all.error}</Notice>

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field label="Plant">
          <select value={plant} onChange={(e) => setPlant(e.target.value)} className="w-48!">
            <option value="">All plants</option>
            {(m.plants || []).map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
        </Field>
        <Field label="Day">
          <input type="date" value={date || m.today || ''} onChange={(e) => setDate(e.target.value)} className="w-48!" />
        </Field>
      </div>

      {monitor.loading && !monitor.data ? <Loading label="Loading the monitor" /> : (
        <>
          <KPIStrip className="mb-6">
            <KPICard label={`Expected ${dayLabel}`} value={m.expected.length} />
            <KPICard label="Waiting for approval" value={m.pendingApproval.length} />
            <KPICard label="SAP errors" value={m.sapErrors.length} />
            <KPICard label="Overdue" value={m.overdue.length} sub="Past expected, not received" />
          </KPIStrip>

          <Section
            title="Waiting for approval"
            caption="Nothing has gone to SAP for these yet."
            rows={m.pendingApproval}
            columns={approvalColumns}
            empty="Nothing waiting for approval."
          />
          <Section
            title="SAP errors"
            caption="SAP did not create the inbound delivery or confirm the receipt. Retry once the cause is fixed."
            rows={m.sapErrors}
            columns={errorColumns}
            empty="No SAP errors."
          />
          <Section title={`Expected ${dayLabel}`} rows={m.expected} columns={trackingColumns} empty={`Nothing expected ${dayLabel}.`} />
          <Section
            title="Overdue"
            caption="Past the supplier's expected date with goods not yet received in SAP."
            rows={m.overdue}
            columns={trackingColumns}
            empty="Nothing overdue."
          />
        </>
      )}

      <section aria-label="All shipments">
        <h2 className="mb-3 text-lg font-semibold text-fg">All shipments</h2>
        {all.loading ? (
          <Loading label="Loading shipments" />
        ) : (
          <Table
            columns={[
              { key: 'id', header: 'Shipment', render: (row) => <span className="mono">{row.id}</span> },
              { key: 'vendorName', header: 'Supplier', render: (row) => row.vendorName || <span className="mono">{row.vendorId}</span> },
              { key: 'poId', header: 'Order', render: (row) => <span className="mono">{row.poId}</span> },
              { key: 'carrierName', header: 'Carrier', render: (row) => row.carrierName || '—' },
              { key: 'trackingNumber', header: 'Tracking', render: (row) => <span className="mono">{row.trackingNumber || '—'}</span> },
              { key: 'shipDate', header: 'Dispatched', render: (row) => <span className="whitespace-nowrap">{formatDate(row.shipDate)}</span> },
              {
                key: 'estimatedDeliveryDate',
                header: 'Due',
                render: (row) => {
                  const late = dueTone(row) === 'overdue' && !['Received', 'Cancelled', 'Rejected'].includes(row.status);
                  return (
                    <span className={`mono text-xs ${late ? 'text-danger' : ''}`}>
                      {formatDate(row.estimatedDeliveryDate)}
                      {late && <span className="ml-1.5 not-italic">(overdue)</span>}
                    </span>
                  );
                },
              },
              // Null until SAP creates one — never invented here (§5.6, #121).
              { key: 'sapInboundDelivery', header: 'SAP inbound delivery', render: (row) => <span className="mono">{row.sapInboundDelivery || '—'}</span> },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
            rows={asns.map((asn) => ({ ...asn, key: asn.id }))}
            // Through to the supplier, where the fuller trading history lives.
            rowLabel={(row) => `supplier ${row.vendorName || row.vendorId}`}
            onRowClick={(row) => router.push(`/workspace/suppliers/${row.vendorId}`)}
            empty="No shipments dispatched yet."
          />
        )}
      </section>

      {rejecting && (
        <RejectShipmentDialog
          asn={rejecting}
          onClose={() => setRejecting(null)}
          onReject={async (reason) => { await poService.rejectShipment(rejecting.id, reason); reloadBoth(); }}
        />
      )}
    </>
  );
}
