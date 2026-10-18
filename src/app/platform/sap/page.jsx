'use client';

import React from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';

// The SAP board: every tenant's connection in one place, which is the screen an
// sap_manager lives on.
//
// It reads the same `/health` endpoint the overview does, because "how is this
// tenant's SAP" has exactly one answer and it should not be computed twice.
// What differs is the framing — driver, environment and breaker here, plan
// usage there.

const CIRCUIT_TONE = {
  closed: 'text-fg-muted',
  'half-open': 'text-warning',
  open: 'text-danger',
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
        <Link href={`/platform/tenants/${row.clientId}/sap`} className="hover:text-accent-text">
          <span className="text-fg">{row.companyName}</span>
          <span className="mono ml-2 text-xs text-fg-subtle">{row.clientId}</span>
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
          {!row.sap.connection.configured && <span className="ml-2 text-xs text-fg-subtle">(default)</span>}
        </span>
      ),
    },
    {
      key: 'environment',
      header: 'Environment',
      render: (row) => (
        <span className={`mono ${row.sap.connection.environment === 'production' ? 'text-success' : 'text-fg-muted'}`}>
          {row.sap.connection.environment}
        </span>
      ),
    },
    {
      key: 'lastTest',
      header: 'Last test',
      render: (row) => {
        const test = row.sap.connection.lastTest;
        if (!test) return <span className="text-xs text-fg-subtle">never tested</span>;
        return (
          <span className={`mono text-xs ${test.ok ? 'text-success' : 'text-danger'}`}>
            {test.ok ? 'passed' : 'failed'} <span className="text-fg-subtle">{formatDate(test.at)}</span>
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
          <span className={`mono text-xs ${CIRCUIT_TONE[state]}`}>
            {CIRCUIT_LABEL[state]}{failures ? ` · ${failures} failed` : ''}
          </span>
        );
      },
    },
    {
      key: 'traffic',
      header: `Failures / ${data?.windowHours ?? 24}h`,
      render: (row) => (
        <span className={`mono ${row.sap.failures ? 'text-danger' : 'text-fg-muted'}`}>
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

      <KPIStrip className="mb-6">
        <KPICard label="Tenants" value={tenants.length} />
        <KPICard label="On production" value={onProduction} />
        <KPICard label="Never configured" value={unconfigured} delta={unconfigured ? 'Running on the simulator' : undefined} deltaTone="warn" />
        <KPICard label="Circuits open" value={breakersOpen} delta={breakersOpen ? 'Calls are being refused' : undefined} deltaTone="down" />
      </KPIStrip>

      <Table columns={columns} rows={tenants.map((row) => ({ ...row, key: row.clientId }))} empty="No tenants yet." />
    </div>
  );
}
