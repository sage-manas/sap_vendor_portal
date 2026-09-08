'use client';

import React, { useState } from 'react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Table, Status, Loading, useResource, formatDate } from '@/components/console/primitives';

// The reconciliation queue (docs/04-sap-runtime-engineering-plan.md Phase 3):
// every RFQ/PO/ASN/GRN/Invoice/Payment that is not honestly `synced` or
// `local` — failed, orphaned, or still pending past its SLA — across every
// tenant. The screen that turns a silent integration failure into a ticket
// someone closes.

const DOCUMENT_TYPES = ['RFQ', 'PurchaseOrder', 'ASN', 'GRN', 'Invoice', 'Payment'];
const SYNC_STATES = ['pending', 'failed', 'orphaned'];

const capitalize = (value) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

export default function ReconciliationPage() {
  const [filters, setFilters] = useState({ clientId: '', type: '', state: '' });
  const [retrying, setRetrying] = useState(null);
  const [retryError, setRetryError] = useState('');

  const query = `?${new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v)))}`;
  const { data, error, loading, reload } = useResource(() => platformApi.reconciliation(query), query);

  const set = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));

  const retry = async (row) => {
    setRetrying(row.pk);
    setRetryError('');
    try {
      await platformApi.retryReconciliation(row.type, row.pk);
      reload();
    } catch (err) {
      setRetryError(err.message);
    } finally {
      setRetrying(null);
    }
  };

  // A PurchaseOrder has no watching job to retry — it reconciles on its own
  // the next time a supplier's SAP-status read correlates it (po.controller.js
  // getSapPoStatus). RFQ/GRN/Payment never appear here in practice (see the
  // notes on their sapSyncState defaults in schema.prisma), but if one ever
  // does, the same "nothing to retry" rule applies until they too are
  // job-backed.
  const retryable = new Set(['ASN', 'Invoice']);

  const columns = [
    { key: 'type', header: 'Type', render: (row) => <span className="mono text-[11px] uppercase tracking-[0.05em] text-text-tertiary">{row.type}</span> },
    { key: 'id', header: 'Document', render: (row) => <span className="mono text-[12px] text-text-primary">{row.id}</span> },
    { key: 'clientId', header: 'Tenant', render: (row) => <span className="mono">{row.clientId}</span> },
    { key: 'sapSyncState', header: 'State', render: (row) => <Status value={capitalize(row.sapSyncState)} /> },
    {
      key: 'sapSyncError',
      header: 'Last error',
      render: (row) => (row.sapSyncError
        ? <span className="text-[12px] text-rose-400">{row.sapSyncError}</span>
        : <span className="text-text-tertiary">—</span>),
    },
    { key: 'updatedAt', header: 'Since', render: (row) => <span className="mono text-text-secondary">{formatDate(row.updatedAt)}</span> },
    {
      key: 'retry',
      header: '',
      render: (row) => (retryable.has(row.type) ? (
        <button
          type="button"
          className="btn btn-o h-7 text-[11px]"
          disabled={retrying === row.pk}
          onClick={() => retry(row)}
        >
          {retrying === row.pk ? 'Retrying…' : 'Retry'}
        </button>
      ) : <span className="text-text-tertiary">—</span>),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Reconciliation"
        caption={data ? `${data.total} ${data.total === 1 ? 'document needs' : 'documents need'} attention · pending SLA ${data.slaHours}h` : ''}
      />

      <Notice onDismiss={() => setRetryError('')}>{error || retryError}</Notice>

      <div className="mb-3 grid gap-2 md:grid-cols-3">
        <input
          value={filters.clientId}
          onChange={(e) => set('clientId', e.target.value)}
          placeholder="Tenant (clientId)"
          className="h-9"
          aria-label="Filter by tenant"
        />
        <select value={filters.type} onChange={(e) => set('type', e.target.value)} className="h-9">
          <option value="">All document types</option>
          {DOCUMENT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
        </select>
        <select value={filters.state} onChange={(e) => set('state', e.target.value)} className="h-9">
          <option value="">All states</option>
          {SYNC_STATES.map((state) => <option key={state} value={state}>{capitalize(state)}</option>)}
        </select>
      </div>

      {loading && !data ? <Loading label="Reading the queue" /> : (
        <Table
          columns={columns}
          rows={(data?.rows || []).map((row) => ({ ...row, key: row.pk }))}
          empty="Nothing needs attention — every document is synced, local, or still within its SLA."
        />
      )}
    </div>
  );
}
