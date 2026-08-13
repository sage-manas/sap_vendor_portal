'use client';

import React from 'react';
import Link from 'next/link';
import { apiClient } from '@/lib/api-client';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Loading, useResource } from '@/components/console/primitives';

// The tenant overview: what needs a decision today, measured against the
// thresholds this workspace set for itself. Every number is a link to the
// screen that acts on it — a count with nowhere to go is a decoration.

const Tile = ({ label, value, caption, href, tone = 'normal' }) => {
  const body = (
    <div className={`border p-4 ${tone === 'alert' ? 'border-rose-500/50' : 'border-border'} ${href ? 'hover:bg-surface2' : ''}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">{label}</p>
      <p className={`mono mt-2 text-2xl tabular-nums ${tone === 'alert' ? 'text-rose-400' : 'text-text-primary'}`}>{value}</p>
      {caption && <p className="mt-1 text-[11px] text-text-tertiary">{caption}</p>}
    </div>
  );

  return href ? <Link href={href}>{body}</Link> : body;
};

const money = (value) => `₹${Number(value || 0).toLocaleString('en-IN')}`;

export default function WorkspaceOverviewPage() {
  const { workspace, can } = useWorkspaceSession();
  const { data, error, loading } = useResource(() => apiClient.get('/workspace/overview'));

  if (loading) return <Loading label="Loading the workspace" />;

  return (
    <>
      <PageHeader
        title={data?.workspace?.companyName || workspace?.companyName || 'Workspace'}
        caption={`${data?.workspace?.plan || '—'} plan · SAP ${data?.workspace?.sapEnvironment || '—'} · ${data?.workspace?.clientId || ''}`}
      />

      <Notice tone="error">{error}</Notice>

      {data && (
        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">Suppliers</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile
                label="Awaiting a decision"
                value={data.suppliers.awaitingDecision}
                caption="Submitted and waiting on you"
                href="/workspace/suppliers?status=Under+Review"
              />
              <Tile
                label="Past the SLA"
                value={data.suppliers.overdueDecision}
                caption={`Older than ${data.thresholds.supplierApprovalSlaHours}h`}
                href="/workspace/suppliers?status=Under+Review"
                tone={data.suppliers.overdueDecision > 0 ? 'alert' : 'normal'}
              />
              <Tile label="Approved" value={data.suppliers.approved} href="/workspace/suppliers?status=Approved" />
              <Tile
                label="Directory"
                value={data.suppliers.limit ? `${data.suppliers.total} / ${data.suppliers.limit}` : data.suppliers.total}
                caption={data.suppliers.limit ? 'Used against your plan limit' : undefined}
                href="/workspace/suppliers"
              />
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">Sourcing and finance</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="RFQs open for bidding" value={data.sourcing.openRfqs} href="/rfqs" />
              <Tile label="Purchase orders open" value={data.sourcing.openPos} href="/pos" />
              <Tile label="Invoices not yet cleared" value={data.finance.invoicesOpen} href="/invoices" />
              <Tile
                label="Above the review amount"
                value={data.finance.invoicesOverThreshold}
                caption={`At or above ${money(data.finance.reviewAmount)}`}
                href="/invoices"
              />
            </div>
          </section>

          {/* Staff numbers belong to whoever can act on them; a buyer's tile
              would only lead to a 403. */}
          {can('user:read') && (
            <section className="space-y-2">
              <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">People</h2>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Tile label="Active staff" value={data.staff.active} href="/workspace/users" />
                <Tile label="Invitations outstanding" value={data.staff.pendingInvitations} href="/workspace/users" />
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
