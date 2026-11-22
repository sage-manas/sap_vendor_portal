'use client';

import React, { useState } from 'react';
import { Check, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/Page';
import DataTable from '@/components/ui/DataTable';
import StatusBadge from '@/components/ui/StatusBadge';
import { displayDate } from '@/lib/displayDate';
import CancelShipmentDialog from './CancelShipmentDialog';
import { ASN_STATUS_TONE } from './AsnDashboard';

// ASN design screen V6: one shipment notice and how far it has got.
//
// The timeline only shows steps the portal can know about: submitted, the
// inbound delivery SAP created, and the goods receipt. "At gate" joins it
// when the status endpoint (docs/abap-requests/inbound-delivery.md, section 4)
// reports gate-in; nothing here claims a step that has not been reported.

const money = (value) => (value == null ? '—' : `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

export default function AsnDetail({ asn, asnId, cancelShipment, onChange, onBack }) {
  const [cancelling, setCancelling] = useState(false);

  if (!asn) {
    return (
      <div>
        <PageHeader breadcrumb={<button type="button" className="text-accent-text hover:underline" onClick={onBack}>ASN</button>} title={asnId} />
        <p className="text-sm text-fg-muted">This shipment is not in your list. It may still be loading, or it belongs to another supplier.</p>
      </div>
    );
  }

  const received = ['Partially Received', 'Received'].includes(asn.status);
  // The approval step shows when the workspace requires one: while waiting,
  // or once given.
  const approval = asn.status === 'Pending Approval' || asn.approvedAt
    ? [{ label: asn.approvedAt ? 'Approved by your buyer' : "Waiting for your buyer's approval", done: Boolean(asn.approvedAt), when: asn.approvedAt ? displayDate(asn.approvedAt) : null }]
    : [];
  const steps = [
    { label: 'Submitted', done: true, when: displayDate(asn.submittedAt || asn.createdAt) },
    ...approval,
    { label: asn.sapInboundDelivery ? `Inbound delivery ${asn.sapInboundDelivery} in SAP` : 'Inbound delivery in SAP', done: Boolean(asn.sapInboundDelivery) },
    { label: asn.status === 'Partially Received' ? 'Partly received' : 'Received', done: received, partial: asn.status === 'Partially Received' },
  ];

  const lineColumns = [
    { key: 'poId', header: 'Order', mono: true, primary: true, render: (item) => item.poId || asn.poId },
    { key: 'line', header: 'Line', mono: true },
    { key: 'description', header: 'Item', wrap: true, render: (item) => item.description || item.materialCode },
    { key: 'shipped', header: 'Shipped', align: 'right', render: (item) => <span className="mono">{item.shippedQuantity}</span> },
    { key: 'received', header: 'Received', align: 'right', render: (item) => <span className="mono">{item.receivedQuantity ?? '—'}</span> },
    {
      key: 'variance',
      header: 'Difference',
      align: 'right',
      render: (item) => (item.receiptVariance == null
        ? <span className="text-fg-subtle">—</span>
        : <span className={`mono ${item.receiptVariance !== 0 ? 'font-medium text-danger' : ''}`}>{item.receiptVariance > 0 ? '+' : ''}{item.receiptVariance}</span>),
    },
    { key: 'uom', header: 'Unit', render: (item) => item.uom || 'EA' },
  ];

  const details = [
    ['Invoice', [asn.invoiceReference, displayDate(asn.invoiceDate), money(asn.invoiceValue)].filter(Boolean).join(' · ')],
    ['Taxable value', money(asn.taxableValue)],
    ['Plant', asn.plant || '—'],
    ['Dispatch', displayDate(asn.shipDate)],
    ['Expected arrival', `${displayDate(asn.estimatedDeliveryDate)}${asn.arrivalTime ? ` ${asn.arrivalTime}` : ''}`],
    ['Transporter', [asn.carrierName, asn.transporterGstin].filter(Boolean).join(' · ') || '—'],
    ['LR / docket', asn.trackingNumber || '—'],
    ['Vehicle', [asn.vehicleNumber, asn.vehicleType].filter(Boolean).join(' · ') || '—'],
    ['Driver mobile', asn.driverMobile || '—'],
    ['E-way bill', asn.ewayBillNo ? `${asn.ewayBillNo} · ${displayDate(asn.ewayBillDate)}` : '—'],
    ['Packages', [asn.packages, asn.grossWeightKg != null && `${asn.grossWeightKg} kg`].filter(Boolean).join(' · ') || '—'],
  ];

  const cancellable = ['Pending Approval', 'Submitted', 'In Transit'].includes(asn.status);
  // ASN design D6: anything not yet received, and a rejected one to resend.
  const changeable = ['Pending Approval', 'Rejected', 'Submitted', 'In Transit'].includes(asn.status);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={<button type="button" className="text-accent-text hover:underline" onClick={onBack}>ASN</button>}
        title={asn.id}
        caption={(asn.status === 'Cancelled' && asn.cancelReason ? `Cancelled: ${asn.cancelReason}` : undefined)
          || (asn.status === 'Rejected' ? `Rejected by your buyer: ${asn.rejectionReason || 'no reason given'}. Change it and send it again.` : undefined)}
        primary={(changeable || cancellable) ? (
          <span className="flex gap-2">
            {changeable && <Button variant="secondary" onClick={onChange}>Change</Button>}
            {cancellable && <Button variant="secondary" onClick={() => setCancelling(true)}>Cancel shipment</Button>}
          </span>
        ) : undefined}
        className="mb-0!"
      />
      <StatusBadge label={asn.status} tone={ASN_STATUS_TONE[asn.status]} />

      {!['Cancelled', 'Rejected'].includes(asn.status) && (
        <ol aria-label="Progress" className="card flex flex-wrap gap-x-8 gap-y-3 p-4 text-sm">
          {steps.map((step) => (
            <li key={step.label} className={`flex items-center gap-2 ${step.done ? 'text-fg' : 'text-fg-muted'}`}>
              <span className={`flex size-5 items-center justify-center rounded-full border ${step.done && !step.partial ? 'border-success text-success' : 'border-border'}`}>
                {step.done && !step.partial ? <Check className="size-3" aria-hidden="true" /> : null}
              </span>
              {step.label}{step.when ? <span className="text-fg-subtle"> · {step.when}</span> : null}
            </li>
          ))}
        </ol>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-fg">Lines</h2>
        <DataTable
          caption="Lines"
          columns={lineColumns}
          rows={(asn.items || []).map((item) => ({ ...item, key: `${item.poId || asn.poId}:${item.line}` }))}
          getRowId={(item) => item.key}
          rowLabel={(item) => `${item.poId || asn.poId} line ${item.line}`}
        />
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-fg">Shipment details</h2>
        <dl className="card grid gap-x-8 gap-y-2 p-4 text-sm sm:grid-cols-2">
          {details.map(([term, value]) => (
            <div key={term} className="flex gap-3"><dt className="w-36 shrink-0 text-fg-muted">{term}</dt><dd className="min-w-0 break-words">{value || '—'}</dd></div>
          ))}
        </dl>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-fg">Documents</h2>
        {(asn.documents || []).length ? (
          <ul className="space-y-1 text-sm">
            {asn.documents.map((doc) => (
              <li key={doc.documentId} className="flex items-center gap-2"><FileText className="size-4 text-fg-subtle" aria-hidden="true" />{doc.originalName}</li>
            ))}
          </ul>
        ) : <p className="text-sm text-fg-muted">No documents attached.</p>}
      </section>

      {cancelling && (
        <CancelShipmentDialog
          asn={asn}
          onClose={() => setCancelling(false)}
          onCancel={(reason) => cancelShipment(asn.id, reason)}
        />
      )}
    </div>
  );
}
