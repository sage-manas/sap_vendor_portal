'use client';

import React from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// The SAP board: every tenant's connection in one place, which is the screen an
// sap_manager lives on.
//
// It reads the same `/health` endpoint the overview does, because "how is this
// tenant's SAP" has exactly one answer and it should not be computed twice.
// What differs is the framing — driver, environment and breaker here, plan
// usage there.

const CIRCUIT_TONE = {
  closed: 'text-text-secondary',
  'half-open': 'text-amber-400',
  open: 'text-rose-400',
};

const CIRCUIT_LABEL = {
  closed: 'passing calls',
  'half-open': 'retrying',
  open: 'refusing calls',
};

export default function PlatformSapPage() {
  const { data, error, loading, reload } = useResource(() => platformApi.health());

  if (loading && !data) return <Loading label="Reading SAP status" />;

  const tenants = data?.tenants || [];
  const unconfigured = tenants.filter((row) => !row.sap.connection.configured).length;
  const onProduction = tenants.filter((row) => row.sap.connection.environment === 'production').length;
  const breakersOpen = tenants.filter((row) => row.sap.connection.circuit.state === 'open').length;

  const columns = [
    {
      key: 'companyName',
      header: 'Tenant',
      render: (row) => (
        <Link href={`/platform/tenants/${row.clientId}/sap`} className="hover:text-emerald-text">
          <span className="text-text-primary">{row.companyName}</span>
          <span className="mono ml-2 text-[11px] text-text-tertiary">{row.clientId}</span>
        </Link>
      ),
    },
    { key: 'sapStatus', header: 'SAP', render: (row) => <Status value={row.sap.status} /> },
    {
      key: 'driver',
      header: 'Driver',
      render: (row) => (
        <span className="mono">
          {row.sap.connection.driver}
          {!row.sap.connection.configured && <span className="ml-2 text-[11px] text-text-tertiary">(default)</span>}
        </span>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      render: (row) => (
        <span className={`mono ${row.sap.connection.environment === 'production' ? 'text-emerald-text' : 'text-text-secondary'}`}>
          {row.sap.connection.environment}
        </span>
      ),
    },
    {
      key: 'lastTest',
      header: 'Last test',
      render: (row) => {
        const test = row.sap.connection.lastTest;
        if (!test) return <span className="text-[11px] text-text-tertiary">never tested</span>;
        return (
          <span className={`mono text-[11px] ${test.ok ? 'text-emerald-text' : 'text-rose-400'}`}>
            {test.ok ? 'passed' : 'failed'} <span className="text-text-tertiary">{formatDate(test.at)}</span>
          </span>
        );
      },
    },
    {
      key: 'circuit',
      header: 'Circuit',
      render: (row) => {
        const { state, failures } = row.sap.connection.circuit;
        return (
          <span className={`mono text-[11px] ${CIRCUIT_TONE[state]}`}>
            {CIRCUIT_LABEL[state]}{failures ? ` · ${failures} failed` : ''}
          </span>
        );
      },
    },
    {
      key: 'traffic',
      header: `Failures / ${data?.windowHours ?? 24}h`,
      render: (row) => (
        <span className={`mono ${row.sap.failures ? 'text-rose-400' : 'text-text-secondary'}`}>
          {row.sap.failures} / {row.sap.calls}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="SAP connections"
        caption={data ? `Generated ${formatDate(data.generatedAt)}` : ''}
      >
        <button type="button" className="btn btn-o h-8" onClick={reload} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </PageHeader>

      <Notice>{error}</Notice>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="metric-panel p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">Tenants</p>
          <p className="mono mt-1.5 text-lg">{tenants.length}</p>
        </div>
        <div className="metric-panel p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">On production</p>
          <p className="mono mt-1.5 text-lg">{onProduction}</p>
        </div>
        <div className="metric-panel p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">Never configured</p>
          <p className={`mono mt-1.5 text-lg ${unconfigured ? 'text-amber-400' : ''}`}>{unconfigured}</p>
        </div>
        <div className="metric-panel p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">Circuits open</p>
          <p className={`mono mt-1.5 text-lg ${breakersOpen ? 'text-rose-400' : ''}`}>{breakersOpen}</p>
        </div>
      </div>

      <Table columns={columns} rows={tenants.map((row) => ({ ...row, key: row.clientId }))} empty="No tenants yet." />
    </div>
  );
}
