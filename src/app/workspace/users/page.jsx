'use client';

import React, { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Field, Status, Table, Loading, useResource, formatDate } from '@/components/console/primitives';
import Modal from '@/components/ui/Modal';

// Tenant staff: who works here, what they may do, and who has been invited but
// has not arrived yet. The roles — and what each one means — come from the
// backend registry through /api/users/roles; there is no role list in this file.

function InviteUser({ roles, onClose, onSent }) {
  const [form, setForm] = useState({ email: '', name: '', role: roles[0]?.role || '' });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setFailed('');
    try {
      await apiClient.post('/users/invitations', form);
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
      title="Invite a colleague"
      footer={
        <>
          <button type="button" className="btn btn-o h-9" onClick={onClose}>Cancel</button>
          <button type="submit" form="invite-user" className="btn btn-v h-9" disabled={busy}>
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </>
      }
    >
      <Notice tone="error">{failed}</Notice>
      <form id="invite-user" onSubmit={submit} className="space-y-3">
        <Field label="Email" type="email" required disabled={busy}
          value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        <Field label="Name" disabled={busy}
          value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <Field label="Role">
          <select className="w-full" value={form.role} disabled={busy}
            onChange={(event) => setForm({ ...form, role: event.target.value })}>
            {roles.map(({ role }) => <option key={role} value={role}>{role}</option>)}
          </select>
        </Field>
        <p className="text-[11px] leading-relaxed text-text-tertiary">
          {roles.find((entry) => entry.role === form.role)?.description}
        </p>
      </form>
    </Modal>
  );
}

export default function UsersPage() {
  const { can, user: me, refresh } = useWorkspaceSession();
  const [dialog, setDialog] = useState(false);
  const [done, setDone] = useState('');

  const { data, error, loading, reload, setError } = useResource(async () => {
    const [users, invitations, roles] = await Promise.all([
      apiClient.get('/users'),
      apiClient.get('/users/invitations?status=Pending'),
      apiClient.get('/users/roles'),
    ]);
    return { users: users.users, invitations: invitations.invitations, roles: roles.roles };
  });

  const act = async (fn, message) => {
    try {
      await fn();
      setDone(message);
      reload();
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const changeRole = (user, role) =>
    act(() => apiClient.patch(`/users/${user.pk}`, { role }), `${user.email} is now ${role}.`);

  const setStatus = (user, status) =>
    act(() => apiClient.put(`/users/${user.pk}/status`, { status }),
      `${user.email} was ${status === 'Active' ? 'reactivated' : 'suspended'}.`);

  const revoke = (invitation) =>
    act(() => apiClient.delete(`/users/invitations/${invitation.pk}`),
      `The invitation to ${invitation.email} was revoked.`);

  if (loading) return <Loading label="Loading the team" />;

  const manageable = can('user:manage');

  const userColumns = [
    {
      key: 'name',
      header: 'Person',
      render: (row) => (
        <div>
          <p className="text-text-primary">{row.name || row.email}</p>
          <p className="mono text-[11px] text-text-tertiary">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => (
        manageable && row.pk !== me?.pk ? (
          <select className="h-8" value={row.role} onChange={(event) => changeRole(row, event.target.value)}>
            {data.roles.map(({ role }) => <option key={role} value={role}>{role}</option>)}
          </select>
        ) : <span className="mono">{row.role}</span>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
    { key: 'lastLoginAt', header: 'Last seen', render: (row) => <span className="mono text-[11px]">{formatDate(row.lastLoginAt)}</span> },
    ...(manageable ? [{
      key: 'actions',
      header: '',
      render: (row) => (
        row.pk === me?.pk ? <span className="text-[11px] text-text-tertiary">That’s you</span> : (
          <div className="flex justify-end">
            <button
              type="button"
              className={`btn h-8 px-2.5 ${row.status === 'Active' ? 'btn-r' : 'btn-o'}`}
              onClick={() => setStatus(row, row.status === 'Active' ? 'Suspended' : 'Active')}
            >
              {row.status === 'Active' ? 'Suspend' : 'Reactivate'}
            </button>
          </div>
        )
      ),
    }] : []),
  ];

  const invitationColumns = [
    { key: 'email', header: 'Invited' },
    { key: 'role', header: 'Role' },
    { key: 'expiresAt', header: 'Expires', render: (row) => <span className="mono text-[11px]">{formatDate(row.expiresAt)}</span> },
    ...(manageable ? [{
      key: 'actions',
      header: '',
      render: (row) => (
        <div className="flex justify-end">
          <button type="button" className="btn btn-o h-8 px-2.5" onClick={() => revoke(row)}>Revoke</button>
        </div>
      ),
    }] : []),
  ];

  return (
    <>
      <PageHeader title="Users" caption="Who works in this workspace, and what each of them may do.">
        {can('user:invite') && (
          <button type="button" className="btn btn-v h-9" onClick={() => setDialog(true)}>
            <UserPlus className="size-3.5" /> Invite
          </button>
        )}
      </PageHeader>

      <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>
      <Notice tone="success" onDismiss={() => setDone('')}>{done}</Notice>

      <Table
        columns={userColumns}
        rows={data.users.map((user) => ({ ...user, key: user.pk }))}
        empty="No staff accounts yet."
      />

      <h2 className="mb-2 mt-8 text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
        Invitations outstanding
      </h2>
      <Table
        columns={invitationColumns}
        rows={data.invitations.map((invitation) => ({ ...invitation, key: invitation.pk }))}
        empty="Nobody is waiting on an invitation."
      />

      {dialog && (
        <InviteUser
          roles={data.roles}
          onClose={() => setDialog(false)}
          onSent={(email) => { setDialog(false); setDone(`An invitation is on its way to ${email}.`); reload(); }}
        />
      )}
    </>
  );
}
