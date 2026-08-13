'use client';

import React, { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { PageHeader, Notice, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// This workspace's own trail. The API scopes it to the signed-in tenant — there
// is no tenant selector here, because there is nothing to select — and reduces
// a platform operator to "VendorConnect operations": that the workspace was
// suspended is the tenant's business, which operator did it is not.

const PAGE_SIZE = 50;

export default function WorkspaceAuditPage() {
  const [subject, setSubject] = useState('');
  const [page, setPage] = useState(1);

  const querystring = `page=${page}&limit=${PAGE_SIZE}${subject ? `&subject=${encodeURIComponent(subject)}` : ''}`;
  const { data, error, loading } = useResource(
    () => apiClient.get(`/workspace/audit?${querystring}`),
    querystring
  );

  const columns = [
    { key: 'at', header: 'When', render: (row) => <span className="mono text-[11px]">{formatDate(row.at)}</span> },
    { key: 'action', header: 'What', render: (row) => <span className="mono text-[12px] text-text-primary">{row.action}</span> },
    {
      key: 'actor',
      header: 'Who',
      render: (row) => (
        <div>
          <p className="text-[12px] text-text-primary">{row.actor.email || row.actor.role}</p>
          {row.actor.email && <p className="mono text-[10px] text-text-tertiary">{row.actor.role}</p>}
        </div>
      ),
    },
    {
      key: 'target',
      header: 'On what',
      render: (row) => (
        row.target ? (
          <div>
            <p className="text-[12px] text-text-primary">{row.target.label || row.target.id}</p>
            <p className="mono text-[10px] text-text-tertiary">{row.target.type}</p>
          </div>
        ) : <span className="text-text-tertiary">—</span>
      ),
    },
    {
      key: 'meta',
      header: 'Detail',
      render: (row) => (
        Object.keys(row.meta || {}).length
          ? <span className="mono text-[11px] text-text-secondary">{JSON.stringify(row.meta)}</span>
          : <span className="text-text-tertiary">—</span>
      ),
    },
  ];

  const pages = data ? Math.max(Math.ceil(data.total / data.limit), 1) : 1;

  return (
    <>
      <PageHeader title="Audit" caption="Everything that happened in this workspace, and who did it." />

      <Notice tone="error">{error}</Notice>

      <div className="mb-4 flex items-center gap-2">
        <select
          className="h-9"
          value={subject}
          onChange={(event) => { setSubject(event.target.value); setPage(1); }}
        >
          <option value="">Everything</option>
          {/* The subjects come from the backend's action registry. */}
          {(data?.subjects || []).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>

        {data && (
          <span className="ml-auto text-[11px] text-text-tertiary">
            {data.total} {data.total === 1 ? 'entry' : 'entries'}
          </span>
        )}
      </div>

      {loading ? (
        <Loading label="Reading the trail" />
      ) : (
        <>
          <Table
            columns={columns}
            rows={(data?.entries || []).map((entry) => ({ ...entry, key: entry.id }))}
            empty="Nothing has happened here yet."
          />

          {pages > 1 && (
            <div className="mt-3 flex items-center justify-end gap-2">
              <button type="button" className="btn btn-o h-8 px-2.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span className="mono text-[11px] text-text-tertiary">{page} / {pages}</span>
              <button type="button" className="btn btn-o h-8 px-2.5" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
