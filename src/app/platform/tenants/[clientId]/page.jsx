'use client';

import React, { use, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Mail, PlugZap } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { usePlatformSession } from '@/lib/platform-session';
import { PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// One tenant: its configuration, who administers it, how much of it exists,
// and the lifecycle actions. Termination is soft and says so — the export
// button beside it is the reason that matters.

const LIFECYCLE = {
  Trial: [{ action: 'suspend', label: 'Suspend', className: 'btn-r' }, { action: 'terminate', label: 'Terminate', className: 'btn-r' }],
  Active: [{ action: 'suspend', label: 'Suspend', className: 'btn-r' }, { action: 'terminate', label: 'Terminate', className: 'btn-r' }],
  Suspended: [{ action: 'reactivate', label: 'Reactivate', className: 'btn-g' }, { action: 'terminate', label: 'Terminate', className: 'btn-r' }],
  Terminated: [],
};

const CONFIRM = {
  suspend: 'Suspend this workspace? Its users will not be able to sign in.',
  terminate: 'Terminate this workspace? Nobody will be able to sign in. Data is retained and can still be exported.',
  reactivate: 'Reactivate this workspace?',
};

export default function TenantDetailPage({ params }) {
  const { clientId } = use(params);
  const { can } = usePlatformSession();
  const { data, error, loading, reload } = useResource(() => platformApi.getTenant(clientId), clientId);

  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState(null);

  const act = async (fn, note) => {
    setBusy(true);
    setFailure('');
    try {
      const res = await fn();
      setMessage(note || res.message || 'Done.');
      await reload();
    } catch (err) {
      setFailure(err.message);
    } finally {
      setBusy(false);
    }
  };

  const lifecycle = (action) => {
    const reason = window.prompt(`${CONFIRM[action]}\n\nReason (recorded in the audit trail):`);
    if (reason === null) return;
    act(() => platformApi.tenantLifecycle(clientId, action, reason));
  };

  const exportTenant = () => act(async () => {
    const payload = await platformApi.exportTenant(clientId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `${payload.tenant.slug}-export.json` });
    link.click();
    URL.revokeObjectURL(url);
    return { message: 'Export downloaded. The download is recorded in the audit trail.' };
  });

  const saveEdit = (event) => {
    event.preventDefault();
    act(async () => {
      await platformApi.updateTenant(clientId, {
        companyName: edit.companyName,
        plan: edit.plan,
        limits: {
          vendors: Number(edit.vendors),
          rfqsPerMonth: Number(edit.rfqsPerMonth),
          storageMb: Number(edit.storageMb),
        },
      });
      setEdit(null);
      return { message: 'Configuration updated.' };
    });
  };

  if (loading && !data) return <Loading label="Loading workspace" />;
  if (!data) return <Notice>{error || 'Workspace not found.'}</Notice>;

  const { tenant, administrators, counts } = data;

  return (
    <div>
      <Link href="/platform/tenants" className="mb-3 inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-primary">
        <ArrowLeft className="size-3.5" /> All tenants
      </Link>

      <PageHeader
        title={tenant.companyName}
        caption={`${tenant.clientId} · ${tenant.slug} · created ${formatDate(tenant.createdAt)}${tenant.createdBy ? ` by ${tenant.createdBy}` : ''}`}
      >
        <Status value={tenant.status} />
        {can('sap:configure') && (
          <Link href={`/platform/tenants/${clientId}/sap`} className="btn btn-o h-8">
            <PlugZap className="size-3.5" /> SAP
          </Link>
        )}
        {can('tenant:manage') && (
          <>
            <button type="button" className="btn btn-o h-8" onClick={exportTenant} disabled={busy}>
              <Download className="size-3.5" /> Export
            </button>
            {LIFECYCLE[tenant.status].map((option) => (
              <button key={option.action} type="button" className={`btn ${option.className} h-8`} disabled={busy}
                onClick={() => lifecycle(option.action)}>
                {option.label}
              </button>
            ))}
          </>
        )}
      </PageHeader>

      <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>
      <Notice onDismiss={() => setFailure('')}>{failure || error}</Notice>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="card p-4 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-text-primary">Configuration</h2>
            {can('tenant:manage') && !edit && (
              <button type="button" className="btn btn-o h-7 text-[11px]" onClick={() => setEdit({
                companyName: tenant.companyName,
                plan: tenant.plan,
                vendors: tenant.limits?.vendors ?? '',
                rfqsPerMonth: tenant.limits?.rfqsPerMonth ?? '',
                storageMb: tenant.limits?.storageMb ?? '',
              })}>Edit</button>
            )}
          </div>

          {edit ? (
            <form onSubmit={saveEdit} className="grid gap-4 md:grid-cols-2">
              <Field label="Company name" required value={edit.companyName}
                onChange={(e) => setEdit({ ...edit, companyName: e.target.value })} />
              <Field label="Plan" value={edit.plan} onChange={(e) => setEdit({ ...edit, plan: e.target.value })} />
              <Field label="Supplier limit" type="number" min="1" value={edit.vendors}
                onChange={(e) => setEdit({ ...edit, vendors: e.target.value })} />
              <Field label="RFQs per month" type="number" min="1" value={edit.rfqsPerMonth}
                onChange={(e) => setEdit({ ...edit, rfqsPerMonth: e.target.value })} />
              <Field label="Storage (MB)" type="number" min="1" value={edit.storageMb}
                onChange={(e) => setEdit({ ...edit, storageMb: e.target.value })} />
              <div className="flex items-end gap-2">
                <button type="submit" className="btn btn-v h-9" disabled={busy}>Save</button>
                <button type="button" className="btn btn-o h-9" onClick={() => setEdit(null)} disabled={busy}>Cancel</button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] md:grid-cols-3">
              {[
                ['Workspace address', tenant.slug],
                ['Plan', tenant.plan],
                ['Supplier limit', tenant.limits?.vendors],
                ['RFQs per month', tenant.limits?.rfqsPerMonth],
                ['Storage (MB)', tenant.limits?.storageMb],
                ['Activated', formatDate(tenant.activatedAt)],
                ['Suspended', formatDate(tenant.suspendedAt)],
                ['Terminated', formatDate(tenant.terminatedAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="label mb-0.5">{label}</dt>
                  <dd className="mono text-text-primary">{value ?? '—'}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="card p-4">
          <h2 className="mb-4 text-[15px] font-semibold text-text-primary">Contents</h2>
          <dl className="space-y-1.5 text-[13px]">
            {Object.entries(counts).map(([name, count]) => (
              <div key={name} className="flex items-center justify-between border-b border-border pb-1.5 last:border-0">
                <dt className="text-text-secondary">{name}</dt>
                <dd className="mono">{count}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <section className="mt-5">
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Administrators</h2>
        <Table
          columns={[
            { key: 'email', header: 'Email' },
            { key: 'name', header: 'Name', render: (row) => <span className="text-text-primary">{row.name}</span> },
            { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            {
              key: 'mustChangePassword',
              header: 'Credentials',
              render: (row) => (
                <span className="mono text-[11px] text-text-tertiary">
                  {row.mustChangePassword ? 'temporary — not yet changed' : 'set by the user'}
                </span>
              ),
            },
            { key: 'lastLoginAt', header: 'Last sign-in', render: (row) => <span className="mono text-text-secondary">{formatDate(row.lastLoginAt)}</span> },
            ...(can('tenant:manage') ? [{
              key: 'actions',
              header: '',
              render: (row) => (
                <button
                  type="button" className="btn btn-o h-7 text-[11px]" disabled={busy}
                  onClick={() => act(() => platformApi.reissueCredentials(clientId, row.id))}
                >
                  <Mail className="size-3" /> Re-issue
                </button>
              ),
            }] : []),
          ]}
          rows={administrators.map((admin) => ({ ...admin, key: admin.id }))}
          empty="This workspace has no administrator — re-provisioning is needed."
        />
      </section>
    </div>
  );
}
