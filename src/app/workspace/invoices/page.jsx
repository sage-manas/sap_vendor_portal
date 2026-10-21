'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { invoiceService } from '@/features/billing/services/invoiceService';
import {
  PageHeader, Notice, Status, Table, Loading, ListFilters, useResource, formatDate,
} from '@/components/console/primitives';
import { useListQuery } from '@/components/console/useListQuery';
import { formatMoney } from '@/lib/money';

// Every invoice submitted against this workspace's purchase orders, across
// every supplier — the finance (and client_admin) tenant-wide view. GET
// /api/invoices already returns every vendor's invoices to tenant staff with
// no vendorId filter (see backend/tests/tenant-wide-visibility.test.js).
//
// Read-only: MIRO posting is AP's own transaction in SAP, not something this
// portal performs (see PROJECT_CONTEXT.md §5.6) — a row here is what to
// reconcile against SAP, not something to act on from this screen. A row
// links through to the supplier it belongs to, since that is where the
// fuller trading history (payments, TDS, GRNs) already lives.

const PAGE_SIZE = 50;

// The named groups come from the backend's status registry (see
// utils/listFilters.js); the literal statuses are INVOICE_STATUS. "Not yet
// cleared" is the group the overview's own tile counts, so the tile links here
// with `?view=open` and the two numbers agree.
const SHOW = [
  { value: 'view:open', label: 'Not yet cleared' },
  { value: 'status:Submitted', label: 'Submitted' },
  { value: 'status:Under Review', label: 'Under review' },
  { value: 'status:Match Warning', label: 'Match warning' },
  { value: 'status:Approved', label: 'Approved' },
  { value: 'status:Posted in SAP', label: 'Posted in SAP' },
  { value: 'status:Cleared', label: 'Cleared' },
  { value: 'status:Rejected', label: 'Rejected' },
];

export default function WorkspaceInvoicesPage() {
  const router = useRouter();
  // `minAmount` has no control of its own: it exists for the overview's
  // "Above the review amount" tile, whose threshold is a tenant setting rather
  // than something a reader would type. It is read from the URL and kept
  // through paging, so the tile's link stays the tile's question.
  const query = useListQuery({
    pageSize: PAGE_SIZE,
    filterKeys: ['view', 'status', 'from', 'to', 'vendorId', 'minAmount'],
  });
  const { data, error, loading } = useResource(
    () => invoiceService.getInvoices(query.params),
    query.key,
  );
  const invoices = data?.invoices || [];

  return (
    <>
      <PageHeader title="Invoices" caption="Every invoice submitted against this workspace's orders, across every supplier" />
      <Notice tone="error">{error}</Notice>

      <ListFilters query={query} show={SHOW} dateLabel="Invoiced" />

      {loading ? (
        <Loading label="Loading invoices" />
      ) : (
        <Table
          columns={[
            { key: 'invoiceNumber', header: 'Invoice', render: (row) => <span className="mono">{row.invoiceNumber || row.id}</span> },
            // Finding 4.3 — see the same note in the purchase-orders list.
            {
              key: 'vendorName',
              header: 'Supplier',
              render: (row) => (row.vendorName ? (
                <span className="flex flex-col">
                  <span>{row.vendorName}</span>
                  <span className="mono text-xs text-fg-subtle">{row.vendorId}</span>
                </span>
              ) : <span className="mono">{row.vendorId}</span>),
            },
            { key: 'poId', header: 'Order', render: (row) => <span className="mono">{row.poId}</span> },
            { key: 'totalAmount', header: 'Amount', align: 'right', render: (row) => <span className="mono">{formatMoney(row.totalAmount, row.currency)}</span> },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            { key: 'invoiceDate', header: 'Invoiced', render: (row) => <span className="whitespace-nowrap">{formatDate(row.invoiceDate)}</span> },
          ]}
          rows={invoices.map((invoice) => ({ ...invoice, key: invoice.id }))}
          rowLabel={(row) => `supplier ${row.vendorName || row.vendorId}`}
          onRowClick={(row) => router.push(`/workspace/suppliers/${row.vendorId}`)}
          empty={query.active ? 'No invoices match these filters.' : 'No invoices submitted yet.'}
          pagination={{
            page: query.page,
            pageSize: PAGE_SIZE,
            total: data?.pagination?.total ?? invoices.length,
            onPageChange: query.setPage,
            noun: 'invoices',
          }}
        />
      )}
    </>
  );
}
