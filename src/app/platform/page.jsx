'use client';

import React from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';

// The health board. Every number here is about a tenant's *operation* — is its
// SAP answering, is it near its plan limits, is anyone signing in — never about
// what is inside its documents.

// "2 / 50" reads as usage; "2" alone does not. A tenant with no limit shows the
// count and an explicit dash rather than a fabricated ceiling.
const Usage = ({ entry }) => {
  if (!entry) return <span className="mono text-fg-subtle">—</span>;
  return (
    <span className={`mono ${entry.breached ? 'text-danger' : ''}`}>
      {entry.used}{entry.limit ? ` / ${entry.limit}` : ' / ∞'}
    </span>
  );
};

export default function PlatformOverviewPage() {
  const { data, error, loading, reload } = useResource(() => platformApi.health());

  if (loading && !data) return <Loading label="Reading platform health" />;

  const columns = [
    {
      key: 'companyName',
      header: 'Tenant',
      render: (row) => (
        <Link href={`/platform/tenants/${row.clientId}`} className="hover:text-accent-text">
          <span className="text-fg">{row.companyName}</span>
          <span className="mono ml-2 text-xs text-fg-subtle">{row.clientId}</span>
        </Link>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    { key: 'sap', header: 'SAP', render: (row) => <Status value={row.sap.status} /> },
    {
      key: 'errorRate',
      header: `Failures / ${data?.windowHours ?? 24}h`,
      align: 'right',
      render: (row) => (
        <span className={`mono ${row.sap.failures ? 'text-danger' : 'text-fg-muted'}`}>
          {row.sap.failures} / {row.sap.calls}
        </span>
      ),
    },
    { key: 'vendors', header: 'Suppliers', align: 'right', render: (row) => <Usage entry={row.usage.vendors} /> },
    { key: 'rfqs', header: 'RFQs this month', align: 'right', render: (row) => <Usage entry={row.usage.rfqsThisMonth} /> },
    // Issue #116: limitStorageMb existed on Client and was editable here, but
    // usage.storageMb never had anywhere to be seen until now — the same
    // Usage component every other metered thing already renders with.
    { key: 'storage', header: 'Storage (MB)', align: 'right', render: (row) => <Usage entry={row.usage.storageMb} /> },
    {
      key: 'users',
      header: 'Active users (30d)',
      align: 'right',
      render: (row) => <span className="mono">{row.usage.users.activeLast30Days} / {row.usage.users.total}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Platform health"
        caption={data ? `Generated ${formatDate(data.generatedAt)} · SAP figures cover the last ${data.windowHours} hours` : ''}
      >
        <button type="button" onClick={reload} className="btn btn-o h-8" disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </PageHeader>

      <Notice>{error}</Notice>

      {data && (
        <>
          <KPIStrip className="mb-6">
            <KPICard label="Tenants" value={data.platform.tenants.total} />
            <KPICard label="Active" value={data.platform.tenants.byStatus.Active || 0} />
            <KPICard label="SAP failing" value={data.platform.sapFailing} delta={data.platform.sapFailing ? 'Needs a look' : undefined} deltaTone="down" />
            <KPICard label="Over limit" value={data.platform.limitsBreached} delta={data.platform.limitsBreached ? 'Plan limit reached' : undefined} deltaTone="warn" />
          </KPIStrip>

          <Table
            columns={columns}
            rows={data.tenants.map((tenant) => ({ ...tenant, key: tenant.clientId }))}
            empty="No tenants yet. Create the first one from the Tenants screen."
          />
        </>
      )}
    </div>
  );
}
