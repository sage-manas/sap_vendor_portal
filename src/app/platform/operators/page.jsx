'use client';

import React, { useState } from 'react';
import { Plus, ShieldOff } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate } from '@/components/platform/primitives';

// Operator accounts. Reachable only by super_admin — the nav does not show this
// screen to an sap_manager, and the API refuses it either way.

const ROLES = [
  { value: 'sap_manager', label: 'SAP manager — configures and watches every tenant\'s SAP' },
  { value: 'super_admin', label: 'Super admin — tenants, operators and billing as well' },
];

export default function OperatorsPage() {
  const { data, error, loading, reload } = useResource(() => platformApi.listOperators());
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (fn) => {
    setBusy(true);
    setFailure('');
    try {
      const res = await fn();
      setMessage(res?.message || 'Done.');
      await reload();
    } catch (err) {
      setFailure(err.message);
    } finally {
      setBusy(false);
    }
  };

  const create = (event) => {
    event.preventDefault();
    act(async () => {
      const res = await platformApi.createOperator(form);
      setForm(null);
      return res;
    });
  };

  const columns = [
    {
      key: 'email',
      header: 'Operator',
      render: (row) => (
        <div>
          <p className="text-text-primary">{row.name}</p>
          <p className="mono text-[11px] text-text-tertiary">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        <select
          className="h-8 text-[12px]" value={row.role} disabled={busy}
          onChange={(e) => act(() => platformApi.updateOperator(row.id, { role: e.target.value }))}
        >
          {ROLES.map((role) => <option key={role.value} value={role.value}>{role.value}</option>)}
        </select>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    {
      key: 'mfaEnabled',
      header: 'Second factor',
      render: (row) => (
        <span className={`mono text-[11px] ${row.mfaEnabled ? 'text-emerald-text' : 'text-amber-500'}`}>
          {row.mfaEnabled ? `enrolled ${formatDate(row.mfaEnrolledAt)}` : 'not enrolled — cannot use the console'}
        </span>
      ),
    },
    { key: 'lastLoginAt', header: 'Last sign-in', render: (row) => <span className="mono text-text-secondary">{formatDate(row.lastLoginAt)}</span> },
    {
      key: 'actions',
      header: '',
      render: (row) => (
        <div className="flex justify-end gap-1.5">
          {row.mfaEnabled && (
            <button
              type="button" className="btn btn-o h-7 text-[11px]" disabled={busy}
              title="Clear their authenticator so they can enrol a new device"
              onClick={() => {
                const reason = window.prompt('Reset this operator\'s second factor?\n\nReason (recorded in the audit trail):');
                if (reason !== null) act(() => platformApi.resetOperatorMfa(row.id, reason));
              }}
            >
              <ShieldOff className="size-3" /> Reset MFA
            </button>
          )}
          <button
            type="button" className={`btn h-7 text-[11px] ${row.status === 'Active' ? 'btn-r' : 'btn-g'}`} disabled={busy}
            onClick={() => act(() => platformApi.operatorLifecycle(row.id, row.status === 'Active' ? 'suspend' : 'reactivate'))}
          >
            {row.status === 'Active' ? 'Suspend' : 'Reactivate'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Operators" caption="Platform accounts. Multi-factor authentication is mandatory here and cannot be turned off.">
        {!form && (
          <button type="button" className="btn btn-v h-8" onClick={() => setForm({ email: '', name: '', role: 'sap_manager' })}>
            <Plus className="size-3.5" /> New operator
          </button>
        )}
      </PageHeader>

      <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>
      <Notice onDismiss={() => setFailure('')}>{failure || error}</Notice>

      {form && (
        <form onSubmit={create} className="card mb-5 grid gap-4 p-4 md:grid-cols-3">
          <Field label="Email" type="email" required value={form.email} disabled={busy}
            hint="Their temporary password is emailed here."
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Field label="Name" required value={form.name} disabled={busy}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Field label="Role">
            <select className="w-full" value={form.role} disabled={busy}
              onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
            </select>
          </Field>
          <div className="flex items-center gap-2 md:col-span-3">
            <button type="submit" className="btn btn-v h-9" disabled={busy}>Create operator</button>
            <button type="button" className="btn btn-o h-9" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
          </div>
        </form>
      )}

      {loading && !data ? <Loading label="Loading operators" /> : (
        <Table columns={columns} rows={(data?.operators || []).map((operator) => ({ ...operator, key: operator.id }))} />
      )}
    </div>
  );
}
