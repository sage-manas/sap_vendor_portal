'use client';

import React, { useState } from 'react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Table, Loading, useResource, formatDate } from '@/components/platform/primitives';

// The audit explorer. Filter values come from the server's registries, not from
// what happens to be in the data — an action nobody has performed yet is still
// worth being able to search for.

const PAGE_SIZE = 50;

export default function AuditPage() {
  const [filters, setFilters] = useState({ clientId: '', subject: '', action: '', plane: '', from: '', to: '' });
  const [page, setPage] = useState(1);

  const options = useResource(() => platformApi.auditFilters());

  const query = `?${new URLSearchParams({
    ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
    page: String(page),
    limit: String(PAGE_SIZE),
  })}`;
  const { data, error, loading } = useResource(() => platformApi.audit(query), query);

  const set = (key, value) => {
    setPage(1);
    // Action and subject are two ways of asking the same question; letting both
    // apply would silently return nothing.
    setFilters((prev) => ({ ...prev, [key]: value, ...(key === 'subject' ? { action: '' } : {}), ...(key === 'action' ? { subject: '' } : {}) }));
  };

  const actions = options.data?.actions || [];
  const visibleActions = filters.subject ? actions.filter((action) => action.startsWith(`${filters.subject}.`)) : actions;
  const pages = data ? Math.max(Math.ceil(data.total / PAGE_SIZE), 1) : 1;

  const columns = [
    { key: 'at', header: 'When', render: (row) => <span className="mono text-text-secondary">{formatDate(row.at)}</span> },
    { key: 'action', header: 'Action', render: (row) => <span className="mono text-emerald-text">{row.action}</span> },
    {
      key: 'actor',
      header: 'Actor',
      render: (row) => (
        <div>
          <p className="text-[12px] text-text-primary">{row.actor.email || row.actor.id}</p>
          <p className="mono text-[10px] uppercase tracking-[0.05em] text-text-tertiary">{row.actor.role} · {row.actor.plane}</p>
        </div>
      ),
    },
    { key: 'clientId', header: 'Tenant', render: (row) => <span className="mono">{row.clientId || '—'}</span> },
    {
      key: 'target',
      header: 'Target',
      render: (row) => (row.target?.id
        ? <span className="mono text-[12px]">{row.target.type}: {row.target.label || row.target.id}</span>
        : <span className="text-text-tertiary">—</span>),
    },
    {
      key: 'meta',
      header: 'Detail',
      render: (row) => (
        <span className="mono text-[11px] text-text-secondary">
          {Object.keys(row.meta || {}).length ? JSON.stringify(row.meta) : '—'}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Audit" caption={data ? `${data.total} entries` : ''} />

      <Notice>{error || options.error}</Notice>

      <div className="mb-3 grid gap-2 md:grid-cols-6">
        <select value={filters.clientId} onChange={(e) => set('clientId', e.target.value)} className="h-9">
          <option value="">All tenants</option>
          {(options.data?.tenants || []).map((tenant) => (
            <option key={tenant.clientId} value={tenant.clientId}>{tenant.clientId} — {tenant.companyName}</option>
          ))}
        </select>

        <select value={filters.subject} onChange={(e) => set('subject', e.target.value)} className="h-9">
          <option value="">All subjects</option>
          {(options.data?.subjects || []).map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>

        <select value={filters.action} onChange={(e) => set('action', e.target.value)} className="h-9">
          <option value="">All actions</option>
          {visibleActions.map((action) => <option key={action} value={action}>{action}</option>)}
        </select>

        <select value={filters.plane} onChange={(e) => set('plane', e.target.value)} className="h-9">
          <option value="">All planes</option>
          {(options.data?.planes || []).map((plane) => <option key={plane} value={plane}>{plane}</option>)}
        </select>

        <input type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} className="h-9" aria-label="From" />
        <input type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} className="h-9" aria-label="To" />
      </div>

      {loading && !data ? <Loading label="Reading the trail" /> : (
        <>
          <Table columns={columns} rows={(data?.entries || []).map((entry) => ({ ...entry, key: entry.id }))} empty="Nothing matches those filters." />

          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-[11px] text-text-tertiary">
              <span className="mono">Page {page} of {pages}</span>
              <div className="flex gap-2">
                <button type="button" className="btn btn-o h-7 text-[11px]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <button type="button" className="btn btn-o h-7 text-[11px]" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
