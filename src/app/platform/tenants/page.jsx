'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { usePlatformSession } from '@/lib/platform-session';
import { PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate } from '@/components/platform/primitives';

// The tenant list, and the create flow that is this phase's whole point:
// creating a workspace issues its first client_admin's credentials by email.

const slugify = (value) =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function CreateTenant({ onCreated, onCancel }) {
  const [form, setForm] = useState({ companyName: '', slug: '', plan: 'trial', adminEmail: '', adminName: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const setCompany = (companyName) => setForm((prev) => ({
    ...prev,
    companyName,
    // The address follows the company name until the operator edits it, then
    // stops fighting them.
    slug: slugTouched ? prev.slug : slugify(companyName),
  }));

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await platformApi.createTenant({
        companyName: form.companyName,
        slug: form.slug,
        plan: form.plan,
        admin: { email: form.adminEmail, ...(form.adminName && { name: form.adminName }) },
      });
      onCreated(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card mb-5 p-4">
      <h2 className="mb-4 text-[15px] font-semibold text-text-primary">New workspace</h2>
      <Notice onDismiss={() => setError('')}>{error}</Notice>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Company name" required value={form.companyName} disabled={busy}
          onChange={(e) => setCompany(e.target.value)} />
        <Field label="Workspace address" required value={form.slug} disabled={busy}
          hint="Becomes their subdomain. Cannot be changed later."
          onChange={(e) => { setSlugTouched(true); setForm({ ...form, slug: slugify(e.target.value) }); }} />
        <Field label="Plan" value={form.plan} disabled={busy}
          onChange={(e) => setForm({ ...form, plan: e.target.value })} />
        <div />
        <Field label="Administrator email" type="email" required value={form.adminEmail} disabled={busy}
          hint="Their temporary password is emailed here, and shown nowhere else."
          onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
        <Field label="Administrator name" value={form.adminName} disabled={busy}
          onChange={(e) => setForm({ ...form, adminName: e.target.value })} />
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button type="submit" className="btn btn-v h-9" disabled={busy}>
          {busy ? 'Creating…' : 'Create workspace'}
        </button>
        <button type="button" className="btn btn-o h-9" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  );
}

export default function TenantsPage() {
  const router = useRouter();
  const { can } = usePlatformSession();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');

  const search = `?${new URLSearchParams({ ...(query && { q: query }), ...(status && { status }) })}`;
  const { data, error, loading, reload } = useResource(() => platformApi.listTenants(search), search);

  const columns = [
    {
      key: 'companyName',
      header: 'Company',
      render: (row) => (
        <div>
          <p className="text-text-primary">{row.companyName}</p>
          <p className="mono text-[11px] text-text-tertiary">{row.clientId} · {row.slug}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    { key: 'plan', header: 'Plan' },
    { key: 'limits', header: 'Supplier limit', render: (row) => <span className="mono">{row.limits?.vendors ?? '—'}</span> },
    { key: 'createdAt', header: 'Created', render: (row) => <span className="mono text-text-secondary">{formatDate(row.createdAt)}</span> },
  ];

  return (
    <div>
      <PageHeader title="Tenants" caption={data ? `${data.total} workspace${data.total === 1 ? '' : 's'}` : ''}>
        {can('tenant:manage') && !creating && (
          <button type="button" className="btn btn-v h-8" onClick={() => { setCreating(true); setMessage(''); }}>
            <Plus className="size-3.5" /> New workspace
          </button>
        )}
      </PageHeader>

      <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>
      <Notice>{error}</Notice>

      {creating && (
        <CreateTenant
          onCancel={() => setCreating(false)}
          onCreated={(res) => {
            setCreating(false);
            setMessage(res.message);
            reload();
          }}
        />
      )}

      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" />
          <input
            className="w-full pl-9"
            placeholder="Search by company, address or ID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select className="h-9" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {['Trial', 'Active', 'Suspended', 'Terminated'].map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </div>

      {loading && !data ? <Loading label="Loading tenants" /> : (
        <Table
          columns={columns}
          rows={(data?.tenants || []).map((tenant) => ({ ...tenant, key: tenant.clientId }))}
          empty="No workspaces match."
          onRowClick={(row) => router.push(`/platform/tenants/${row.clientId}`)}
        />
      )}
    </div>
  );
}
