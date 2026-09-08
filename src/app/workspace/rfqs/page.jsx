'use client';

import React from 'react';
import { rfqService } from '@/features/rfq/services/rfqService';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// Every RFQ this workspace has raised, across every supplier — the buyer's
// (and client_admin's) tenant-wide sourcing monitor. GET /api/rfqs already
// returns every vendor's RFQs to tenant staff with no vendorId filter (see
// backend/tests/tenant-wide-visibility.test.js); this is the first screen
// that reads that list in the workspace plane rather than the supplier one.
//
// Read-only, same as Purchase Orders: an RFQ's lifecycle (create, cancel,
// reissue, award) is driven from the supplier-facing RFQ workflow today —
// this screen is for seeing across suppliers, not acting on one.

export default function WorkspaceRfqsPage() {
  const { data, error, loading } = useResource(() => rfqService.getRFQs({ limit: 200 }));
  const rfqs = data?.rfqs || [];

  return (
    <>
      <PageHeader title="RFQs" caption="Every request for quotation this workspace has raised, across every supplier" />
      <Notice tone="error">{error}</Notice>

      {loading ? (
        <Loading label="Loading RFQs" />
      ) : (
        <Table
          columns={[
            { key: 'id', header: 'RFQ', render: (row) => <span className="mono">{row.id}</span> },
            { key: 'description', header: 'Description' },
            {
              key: 'invited',
              header: 'Invited',
              render: (row) => <span className="mono">{(row.invitedVendors || []).length}</span>,
            },
            {
              key: 'bids',
              header: 'Bids received',
              render: (row) => <span className="mono">{(row.bids || []).length}</span>,
            },
            {
              key: 'awardedVendorName',
              header: 'Awarded to',
              render: (row) => (row.awardedVendorName ? <span className="mono">{row.awardedVendorName}</span> : '—'),
            },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            { key: 'deadlineDate', header: 'Deadline', render: (row) => <span className="mono text-[11px]">{formatDate(row.deadlineDate)}</span> },
          ]}
          rows={rfqs.map((rfq) => ({ ...rfq, key: rfq.id }))}
          empty="No RFQs raised yet."
        />
      )}
    </>
  );
}
