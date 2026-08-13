'use client';

import React from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// The health board. Every number here is about a tenant's *operation* — is its
// SAP answering, is it near its plan limits, is anyone signing in — never about
// what is inside its documents.

const Metric = ({ label, value, tone = '' }) => (
  <div className="metric-panel p-3">
    <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">{label}</p>
    <p className={`mono mt-1.5 text-lg ${tone}`}>{value}</p>
  </div>
);

// "2 / 50" reads as usage; "2" alone does not. A tenant with no limit shows the
// count and an explicit dash rather than a fabricated ceiling.
const Usage = ({ entry }) => {
  if (!entry) return <span className="mono text-text-tertiary">—</span>;
  return (
    <span className={`mono ${entry.breached ? 'text-rose-400' : ''}`}>
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
        <Link href={`/platform/tenants/${row.clientId}`} className="hover:text-emerald-text">
          <span className="text-text-primary">{row.companyName}</span>
          <span className="mono ml-2 text-[11px] text-text-tertiary">{row.clientId}</span>
        </Link>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    { key: 'sap', header: 'SAP', render: (row) => <Status value={row.sap.status} /> },
    {
      key: 'errorRate',
      header: `Failures / ${data?.windowHours ?? 24}h`,
      render: (row) => (
        <span className={`mono ${row.sap.failures ? 'text-rose-400' : 'text-text-secondary'}`}>
          {row.sap.failures} / {row.sap.calls}
        </span>
      ),
    },
    { key: 'vendors', header: 'Suppliers', render: (row) => <Usage entry={row.usage.vendors} /> },
    { key: 'rfqs', header: 'RFQs this month', render: (row) => <Usage entry={row.usage.rfqsThisMonth} /> },
    {
      key: 'users',
      header: 'Active users (30d)',
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
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Tenants" value={data.platform.tenants.total} />
            <Metric label="Active" value={data.platform.tenants.byStatus.Active || 0} />
            <Metric label="SAP failing" value={data.platform.sapFailing} tone={data.platform.sapFailing ? 'text-rose-400' : ''} />
            <Metric label="Over limit" value={data.platform.limitsBreached} tone={data.platform.limitsBreached ? 'text-amber-500' : ''} />
          </div>

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
