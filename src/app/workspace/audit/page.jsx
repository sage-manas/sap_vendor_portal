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
    { key: 'at', header: 'When', render: (row) => <span className="whitespace-nowrap text-sm">{formatDate(row.at)}</span> },
    { key: 'action', header: 'What', render: (row) => <span className="mono text-xs text-fg">{row.action}</span> },
    {
      key: 'actor',
      header: 'Who',
      render: (row) => (
        <div>
          <p className="text-sm text-fg">{row.actor.email || row.actor.role}</p>
          {row.actor.email && <p className="mono text-xs text-fg-subtle">{row.actor.role}</p>}
        </div>
      ),
    },
    {
      key: 'target',
      header: 'On what',
      render: (row) => (
        row.target ? (
          <div>
            <p className="text-sm text-fg">{row.target.label || row.target.id}</p>
            <p className="mono text-xs text-fg-subtle">{row.target.type}</p>
          </div>
        ) : <span className="text-fg-subtle">—</span>
      ),
    },
    {
      key: 'meta',
      header: 'Detail',
      render: (row) => (
        Object.keys(row.meta || {}).length
          ? <span className="mono text-xs text-fg-muted">{JSON.stringify(row.meta)}</span>
          : <span className="text-fg-subtle">—</span>
      ),
    },
  ];

  if (!loading && !data) {
    return (
      <>
        <PageHeader title="Audit" caption="Everything that happened in this workspace, and who did it." />
        <Notice tone="error">{error}</Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Audit" caption="Everything that happened in this workspace, and who did it." />

      <Notice tone="error">{error}</Notice>

      <div className="mb-4 flex items-center gap-2">
        <select
          aria-label="Show entries about"
          className="h-9 w-auto! min-w-56"
          value={subject}
          onChange={(event) => { setSubject(event.target.value); setPage(1); }}
        >
          <option value="">Everything</option>
          {/* The subjects come from the backend's action registry. */}
          {(data?.subjects || []).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>

      </div>

      {loading ? (
        <Loading label="Reading the trail" />
      ) : (
        <Table
          columns={columns}
          rows={(data?.entries || []).map((entry) => ({ ...entry, key: entry.id }))}
          empty="Nothing has happened here yet."
          // This screen's own pager moved into the Table primitive with issue
          // #281, which gave the four workspace lists the same one. Two
          // implementations of Previous/Next is how they come to disagree
          // about what the last page is.
          pagination={{
            page,
            pageSize: PAGE_SIZE,
            total: data?.total ?? 0,
            onPageChange: setPage,
            noun: 'entries',
          }}
        />
      )}
    </>
  );
}
