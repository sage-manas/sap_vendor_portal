'use client';

import React from 'react';
import { rfqService } from '@/features/rfq/services/rfqService';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// Every RFQ this workspace's suppliers hold, across every supplier — the
// buyer's (and client_admin's) tenant-wide sourcing monitor. GET /api/rfqs
// already returns every vendor's RFQs to tenant staff with no vendorId filter
// (see backend/tests/tenant-wide-visibility.test.js); this is the first
// screen that reads that list in the workspace plane rather than the
// supplier one.
//
// Every RFQ here originates in SAP (ME41) and is discovered by
// jobs/handlers/sweepQuotations.js, never raised from the portal (issue
// #117) — this screen is read-only, same as Purchase Orders, for the same
// reason: there is no "create" action on a document this workspace does not
// originate. Cancel/reissue/award still act on the RFQ once discovered, from
// the supplier-facing RFQ workflow.

export default function WorkspaceRfqsPage() {
  const { data, error, loading } = useResource(() => rfqService.getRFQs({ limit: 200 }));
  const rfqs = data?.rfqs || [];

  return (
    <>
      <PageHeader title="RFQs" caption="Every request for quotation SAP holds for this workspace's suppliers" />
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
          empty="No RFQs discovered from SAP yet."
        />
      )}
    </>
  );
}
