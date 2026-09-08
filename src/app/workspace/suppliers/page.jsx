'use client';

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Mail, Plus, Search } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import Modal from '@/components/ui/Modal';
import { SUPPLIER_IDENTITY_FIELDS, validateFields } from '@/features/profile/validation';
import DeclineSupplier from '@/features/profile/components/DeclineSupplier';

// The supplier directory: who this workspace buys from, who is waiting on a
// decision, and the two ways a new one arrives — an invitation they answer, or
// a record the tenant enters on their behalf.

const EMPTY_SUPPLIER = Object.fromEntries(SUPPLIER_IDENTITY_FIELDS.map((field) => [field.name, '']));

function AddSupplier({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_SUPPLIER);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const submit = async (event) => {
    event.preventDefault();

    // The same rules the supplier's own registration form applies, and the
    // same ones the API will apply again — this is the fast answer, not the
    // authority.
    const found = validateFields(SUPPLIER_IDENTITY_FIELDS, form);
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    setFailed('');
    try {
      const res = await apiClient.post('/vendors', form);
      onCreated(res.vendor);
    } catch (err) {
      setFailed(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a supplier"
      footer={
        <>
          <button type="button" className="btn btn-o h-9" onClick={onClose}>Cancel</button>
          <button type="submit" form="add-supplier" className="btn btn-v h-9" disabled={busy}>
            {busy ? 'Creating…' : 'Create and email them'}
          </button>
        </>
      }
    >
      <Notice tone="error">{failed}</Notice>
      <p className="mb-4 text-[12px] leading-relaxed text-text-secondary">
        The supplier receives a link to choose their own password and finish their onboarding —
        banking details and documents stay theirs to enter.
      </p>

      <form id="add-supplier" onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SUPPLIER_IDENTITY_FIELDS.map((field) => (
          <div key={field.name}>
            <Field
              label={field.label}
              type={field.type || 'text'}
              value={form[field.name]}
              disabled={busy}
              onChange={(event) => setForm({ ...form, [field.name]: event.target.value })}
            />
            {errors[field.name] && <p className="mt-1 text-[11px] text-rose-400">{errors[field.name]}</p>}
          </div>
        ))}
      </form>
    </Modal>
  );
}

function InviteSupplier({ onClose, onSent }) {
  const [form, setForm] = useState({ email: '', name: '' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setFailed('');
    try {
      await apiClient.post('/vendors/invitations', form);
      onSent(form.email);
    } catch (err) {
      setFailed(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Invite a supplier"
      footer={
        <>
          <button type="button" className="btn btn-o h-9" onClick={onClose}>Cancel</button>
          <button type="submit" form="invite-supplier" className="btn btn-v h-9" disabled={busy}>
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </>
      }
    >
      <Notice tone="error">{failed}</Notice>
      <p className="mb-4 text-[12px] leading-relaxed text-text-secondary">
        They register themselves and land in this queue. An invitation works even when this
        workspace has closed self-service registration.
      </p>

      <form id="invite-supplier" onSubmit={submit} className="space-y-3">
        <Field label="Email" type="email" required disabled={busy}
          value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        <Field label="Company (optional)" disabled={busy}
          value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </form>
    </Modal>
  );
}

export default function SuppliersPage() {
  const { can } = useWorkspaceSession();
  const router = useRouter();
  const params = useSearchParams();

  const status = params.get('status') || '';
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const [done, setDone] = useState('');

  const querystring = `${status ? `status=${encodeURIComponent(status)}&` : ''}${query ? `search=${encodeURIComponent(query)}` : ''}`;
  const { data, error, loading, reload, setError } = useResource(
    () => apiClient.get(`/vendors?limit=100&${querystring}`),
    querystring
  );

  const setStatus = (next) => router.replace(next ? `/workspace/suppliers?status=${encodeURIComponent(next)}` : '/workspace/suppliers');

  const approve = async (supplier) => {
    try {
      await apiClient.put(`/vendors/${supplier.pk}/approve`, {});
      setDone(`${supplier.companyName} was approved and issued a supplier ID.`);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const finish = (message) => {
    setDialog(null);
    setDone(message);
    reload();
  };

  const columns = [
    {
      key: 'companyName',
      header: 'Supplier',
      render: (row) => (
        <div>
          <p className="text-text-primary hover:underline">{row.companyName}</p>
          <p className="mono text-[11px] text-text-tertiary">{row.vendorId} · {row.email}</p>
        </div>
      ),
    },
    { key: 'gstin', header: 'GSTIN' },
    { key: 'sapVendorCode', header: 'Vendor code', render: (row) => <span className="mono">{row.sapVendorCode || '—'}</span> },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    { key: 'submittedAt', header: 'Submitted', render: (row) => <span className="mono text-[11px]">{formatDate(row.submittedAt)}</span> },
    ...(can('vendor:approve') ? [{
      key: 'actions',
      header: '',
      render: (row) => (
        // Which statuses are a decision waiting to happen is the registry's
        // answer, and it arrives with the list.
        (data?.filters?.awaitingDecision || []).includes(row.status) ? (
          <div className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="btn btn-v h-8 px-2.5" onClick={() => approve(row)}>Approve</button>
            <button type="button" className="btn btn-o h-8 px-2.5" onClick={() => setDialog({ kind: 'reject', supplier: row })}>Decline</button>
          </div>
        ) : null
      ),
    }] : []),
  ];

  return (
    <>
      <PageHeader title="Suppliers" caption="The directory, and everyone waiting on a decision. Open a supplier for their full profile.">
        {can('vendor:invite') && (
          <button type="button" className="btn btn-o h-9" onClick={() => setDialog({ kind: 'invite' })}>
            <Mail className="size-3.5" /> Invite
          </button>
        )}
        {can('vendor:create') && (
          <button type="button" className="btn btn-v h-9" onClick={() => setDialog({ kind: 'add' })}>
            <Plus className="size-3.5" /> Add supplier
          </button>
        )}
      </PageHeader>

      <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>
      <Notice tone="success" onDismiss={() => setDone('')}>{done}</Notice>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form
          onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); }}
          className="relative"
        >
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-text-tertiary" />
          <input
            className="h-9 w-64 pl-8"
            placeholder="Name, supplier ID, email or GSTIN"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </form>

        <select className="h-9" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Every status</option>
          {/* Offered by the API's registry, not listed here. */}
          {(data?.filters?.statuses || []).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>

      {loading ? (
        <Loading label="Loading the directory" />
      ) : (
        <Table
          columns={columns}
          rows={(data?.vendors || []).map((vendor) => ({ ...vendor, key: vendor.pk }))}
          empty={query || status ? 'No supplier matches that.' : 'No suppliers yet.'}
          onRowClick={(row) => router.push(`/workspace/suppliers/${row.pk}`)}
        />
      )}

      {dialog?.kind === 'add' && (
        <AddSupplier
          onClose={() => setDialog(null)}
          onCreated={(vendor) => finish(`${vendor.companyName} was created as ${vendor.vendorId}, and has been emailed a link to sign in.`)}
        />
      )}
      {dialog?.kind === 'invite' && (
        <InviteSupplier onClose={() => setDialog(null)} onSent={(email) => finish(`An invitation is on its way to ${email}.`)} />
      )}
      {dialog?.kind === 'reject' && (
        <DeclineSupplier supplier={dialog.supplier} onClose={() => setDialog(null)} onDone={finish} />
      )}
    </>
  );
}
