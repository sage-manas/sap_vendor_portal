'use client';

import React, { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/Page';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';
import DataTable from '@/components/ui/DataTable';
import StatusBadge from '@/components/ui/StatusBadge';
import { SegmentedControl, Tabs } from '@/components/ui/controls';
import { displayDate } from '@/lib/displayDate';
import { useResource } from '@/components/console/primitives';
import { poService } from '@/features/purchase-order/services/poService';
import { shippableLines } from '../lines';

// ASN design screen V1: the supplier's shipment notices and drafts.

export const ASN_STATUS_TONE = {
  Submitted: 'progress', 'In Transit': 'progress', 'Partially Received': 'progress', Received: 'done', Cancelled: 'neutral',
};
const IN_TRANSIT = ['Submitted', 'In Transit', 'Partially Received'];
const STATUS_FILTERS = [
  { value: 'all', label: 'All', match: () => true },
  { value: 'transit', label: 'On the way', match: (s) => IN_TRANSIT.includes(s) },
  { value: 'received', label: 'Received', match: (s) => s === 'Received' },
  { value: 'cancelled', label: 'Cancelled', match: (s) => s === 'Cancelled' },
];

const ordersOf = (asn) => [...new Set([asn.poId, ...(asn.items || []).map((item) => item.poId)].filter(Boolean))];
const totalQty = (asn) => (asn.items || []).reduce((sum, item) => sum + (Number(item.shippedQuantity) || 0), 0);

export default function AsnDashboard({ pos, asns, onCreate, onResume, onOpen }) {
  const [tab, setTab] = useState('shipments');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const draftsResource = useResource(() => poService.listAsnDrafts());
  const drafts = draftsResource.data?.drafts || [];
  const draftsError = draftsResource.error;
  // Read once: the clock is not something a render may depend on.
  const [now] = useState(() => Date.now());

  const openLines = useMemo(() => shippableLines(pos).length, [pos]);
  const monthAgo = now - 30 * 86400000;
  const onTheWay = asns.filter((asn) => IN_TRANSIT.includes(asn.status)).length;
  const receivedLately = asns.filter((asn) => asn.status === 'Received' && new Date(asn.updatedAt || asn.submittedAt).getTime() >= monthAgo).length;

  const needle = query.trim().toLowerCase();
  const rows = asns
    .filter((asn) => STATUS_FILTERS.find((f) => f.value === filter).match(asn.status))
    .filter((asn) => !needle || [asn.id, asn.invoiceReference, asn.vehicleNumber, ...ordersOf(asn)]
      .some((value) => String(value || '').toLowerCase().includes(needle)))
    .map((asn) => ({ ...asn, key: asn.id }));

  const columns = [
    { key: 'id', header: 'ASN', mono: true, primary: true },
    { key: 'submittedAt', header: 'Created', render: (asn) => displayDate(asn.submittedAt || asn.createdAt) },
    { key: 'orders', header: 'Orders', wrap: true, render: (asn) => <span className="mono">{ordersOf(asn).join(', ')}</span> },
    { key: 'plant', header: 'Plant', render: (asn) => asn.plant || '—' },
    { key: 'lines', header: 'Lines', align: 'right', render: (asn) => <span className="mono">{(asn.items || []).length}</span> },
    { key: 'qty', header: 'Total qty', align: 'right', render: (asn) => <span className="mono">{totalQty(asn)}</span> },
    { key: 'vehicleNumber', header: 'Vehicle', render: (asn) => <span className="mono">{asn.vehicleNumber || '—'}</span> },
    { key: 'eta', header: 'ETA', render: (asn) => displayDate(asn.estimatedDeliveryDate) },
    { key: 'status', header: 'Status', render: (asn) => <StatusBadge label={asn.status} tone={ASN_STATUS_TONE[asn.status]} /> },
    { key: 'sapInboundDelivery', header: 'SAP delivery', render: (asn) => <span className="mono">{asn.sapInboundDelivery || '—'}</span> },
  ];

  const deleteDraft = async (draft) => {
    if (!confirm('Delete this draft? This cannot be undone.')) return;
    try {
      await poService.deleteAsnDraft(draft.pk);
      draftsResource.reload();
    } catch (e) {
      alert('Could not delete the draft: ' + (e.message || e));
    }
  };

  const draftColumns = [
    { key: 'updatedAt', header: 'Saved', primary: true, render: (draft) => new Date(draft.updatedAt).toLocaleString('en-IN') },
    {
      key: 'orders',
      header: 'Orders',
      wrap: true,
      render: (draft) => {
        const ids = [...new Set([draft.poId, ...((draft.payload?.items) || []).map((item) => item.poId)].filter(Boolean))];
        return <span className="mono">{ids.join(', ') || '—'}</span>;
      },
    },
    { key: 'invoice', header: 'Invoice', render: (draft) => <span className="mono">{draft.payload?.invoiceReference || '—'}</span> },
    { key: 'step', header: 'Step', render: (draft) => `${draft.step} of 4` },
  ];

  return (
    <div>
      <PageHeader
        title="ASN"
        description="Shipment notices you have sent your buyer, and drafts you have not sent yet."
        primary={<Button onClick={onCreate}><Plus className="mr-1.5 size-4" aria-hidden="true" />Create ASN</Button>}
      />

      <KPIStrip className="mb-6">
        <KPICard label="Open PO lines" value={openLines} sub="Ready to ship" />
        <KPICard label="Drafts" value={drafts.length} sub="Not sent" />
        <KPICard label="On the way" value={onTheWay} sub="Sent, not fully received" />
        <KPICard label="Received" value={receivedLately} sub="Last 30 days" />
      </KPIStrip>

      <Tabs
        aria-label="Shipment notices"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'shipments', label: `Shipments (${asns.length})` },
          { value: 'drafts', label: `Drafts (${drafts.length})` },
        ]}
      />

      <div className="pt-4">
        {tab === 'shipments' && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <SegmentedControl aria-label="Status" options={STATUS_FILTERS} value={filter} onChange={setFilter} size="sm" />
              <label className="relative">
                <span className="sr-only">Search shipments</span>
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="ASN, order, invoice or vehicle"
                  className="w-72! pl-8!"
                />
              </label>
            </div>
            <DataTable
              caption="Shipments"
              columns={columns}
              rows={rows}
              onRowClick={onOpen}
              rowLabel={(asn) => asn.id}
              empty={asns.length
                ? 'No shipments match these filters.'
                : 'No shipment notices yet. Create one when goods leave for your buyer.'}
            />
          </>
        )}

        {tab === 'drafts' && (
          <>
            {draftsError && <p className="mb-3 text-sm text-danger">{draftsError}</p>}
            <DataTable
              caption="Drafts"
              columns={draftColumns}
              rows={drafts.map((draft) => ({ ...draft, key: draft.pk }))}
              rowLabel={(draft) => `draft saved ${new Date(draft.updatedAt).toLocaleString('en-IN')}`}
              inlineActions={(draft) => (
                <span className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => onResume(draft)}>Resume</Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteDraft(draft)}>Delete</Button>
                </span>
              )}
              empty="No drafts. Save draft on any step of a new ASN keeps it here."
            />
          </>
        )}
      </div>
    </div>
  );
}
