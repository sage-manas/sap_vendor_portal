'use client';

import React, { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpCircle, CheckCircle2, PlugZap, XCircle } from 'lucide-react';
import { platformApi } from '@/lib/platform-client';
import { usePlatformSession } from '@/lib/platform-session';
import { PageHeader, Notice, Field, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// One tenant's SAP configuration, both environments side by side.
//
// The form is drawn from the driver catalogue the API returns — field names,
// labels and types — so a fourth driver appears here without this file
// changing. Credentials are write-only by construction: the API sends back the
// *names* of the ones that are set, and the inputs below start empty, so a
// blank password field means "leave it alone" rather than "clear it".

const ENVIRONMENT_CAPTION = {
  sandbox: 'Where a connection is proven. Safe to break.',
  production: 'The tenant\'s real system. Reached only through an explicit promotion.',
};

const readPath = (object, path) =>
  path.split('.').reduce((value, key) => (value == null ? value : value[key]), object);

const writePath = (object, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((node, key) => {
    node[key] = { ...(node[key] || {}) };
    return node[key];
  }, object);
  target[last] = value;
  return object;
};

const TestResult = ({ result }) => {
  if (!result) return <span className="text-[11px] text-text-tertiary">Never tested</span>;

  const Icon = result.ok ? CheckCircle2 : XCircle;
  return (
    <span className={`flex items-start gap-1.5 text-[11px] ${result.ok ? 'text-emerald-text' : 'text-rose-400'}`}>
      <Icon className="mt-px size-3.5 shrink-0" />
      <span>
        {result.message}
        <span className="text-text-tertiary">
          {' · '}{formatDate(result.at)}
          {result.latencyMs != null && ` · ${result.latencyMs}ms`}
          {result.testedBy && ` · ${result.testedBy}`}
        </span>
      </span>
    </span>
  );
};

const ConnectionCard = ({ environment, connection, drivers, busy, onSave, onTest, onPromote, canConfigure }) => {
  const [draft, setDraft] = useState(null);

  const definition = useMemo(
    () => drivers.find((entry) => entry.key === (draft?.driver || connection?.driver)) || drivers[0],
    [drivers, draft, connection]
  );

  const startEditing = () => setDraft({
    driver: connection?.driver || drivers[0].key,
    config: { ...(connection?.config || {}) },
    secrets: {},
  });

  const submit = (event) => {
    event.preventDefault();
    // Only credentials the operator actually typed are sent. An untouched field
    // must not overwrite a stored secret with an empty string.
    const secrets = Object.fromEntries(Object.entries(draft.secrets).filter(([, value]) => value !== ''));
    onSave(environment, { driver: draft.driver, config: draft.config, secrets })
      .then(() => setDraft(null));
  };

  return (
    <section className={`card p-4 ${connection?.active ? 'border-border-em' : ''}`}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold capitalize text-text-primary">{environment}</h2>
        {connection?.active && <span className="status-badge status-badge-active">live</span>}
      </div>
      <p className="mb-4 text-[11px] text-text-tertiary">{ENVIRONMENT_CAPTION[environment]}</p>

      {draft ? (
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Driver">
            <select
              className="w-full"
              value={draft.driver}
              onChange={(event) => setDraft({ ...draft, driver: event.target.value, config: {}, secrets: {} })}
            >
              {drivers.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}{entry.implemented ? '' : ' — not implemented yet'}
                </option>
              ))}
            </select>
          </Field>
          <p className="-mt-2 text-[11px] text-text-tertiary">{definition.description}</p>

          {definition.configFields.map((field) => (
            <Field
              key={field.name}
              label={field.label}
              type={field.type === 'number' ? 'number' : 'text'}
              placeholder={field.placeholder || (field.default != null ? String(field.default) : '')}
              value={readPath(draft.config, field.name) ?? ''}
              onChange={(event) => setDraft({
                ...draft,
                config: writePath({ ...draft.config }, field.name,
                  field.type === 'number' ? Number(event.target.value) : event.target.value),
              })}
            />
          ))}

          {definition.secretFields.map((field) => (
            <Field
              key={field.name}
              label={field.label}
              type="password"
              autoComplete="new-password"
              hint={connection?.configuredSecrets?.includes(field.name)
                ? 'Set. Leave blank to keep it, or type a new value to replace it.'
                : 'Not set. Stored encrypted; never shown again.'}
              value={draft.secrets[field.name] ?? ''}
              onChange={(event) => setDraft({ ...draft, secrets: { ...draft.secrets, [field.name]: event.target.value } })}
            />
          ))}

          <div className="flex gap-2">
            <button type="submit" className="btn btn-v h-9" disabled={busy}>Save</button>
            <button type="button" className="btn btn-o h-9" onClick={() => setDraft(null)} disabled={busy}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
            <div>
              <dt className="label mb-0.5">Driver</dt>
              <dd className="mono text-text-primary">
                {connection ? (drivers.find((entry) => entry.key === connection.driver)?.label ?? connection.driver) : '—'}
              </dd>
            </div>
            <div>
              <dt className="label mb-0.5">Credentials</dt>
              <dd className="mono text-text-primary">
                {connection?.configuredSecrets?.length ? connection.configuredSecrets.join(', ') : 'none'}
              </dd>
            </div>
            {connection && Object.entries(connection.config || {}).map(([key, value]) => (
              <div key={key}>
                <dt className="label mb-0.5">{key}</dt>
                <dd className="mono text-text-primary break-all">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 border-t border-border pt-3">
            <TestResult result={connection?.lastTest} />
          </div>

          {canConfigure && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="btn btn-o h-8" onClick={startEditing} disabled={busy}>
                {connection ? 'Edit' : 'Configure'}
              </button>
              <button type="button" className="btn btn-o h-8" onClick={() => onTest(environment)} disabled={busy || !connection}>
                <PlugZap className="size-3.5" /> Test connection
              </button>
              {!connection?.active && (
                <button type="button" className="btn btn-v h-8" onClick={() => onPromote(environment)} disabled={busy || !connection}>
                  <ArrowUpCircle className="size-3.5" /> Make live
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default function TenantSapPage({ params }) {
  const { clientId } = use(params);
  const { can } = usePlatformSession();
  const canConfigure = can('sap:configure');

  const { data, error, loading, reload } = useResource(() => platformApi.getSap(clientId), clientId);
  const trail = useResource(() => platformApi.sapAudit(clientId), clientId);

  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (fn) => {
    setBusy(true);
    setFailure('');
    setMessage('');
    try {
      const note = await fn();
      if (note) setMessage(note);
      await Promise.all([reload(), trail.reload()]);
    } catch (err) {
      // A driver's field errors arrive as a map; joining them beats showing
      // "the connection details are incomplete" and leaving them to guess which.
      setFailure(err.errors ? Object.entries(err.errors).map(([key, value]) => `${key}: ${value}`).join(' · ') : err.message);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const save = (environment, body) =>
    act(async () => {
      await platformApi.configureSap(clientId, environment, body);
      return `${environment} connection saved. Test it before making it live.`;
    }).catch(() => {});

  const test = (environment) => act(async () => {
    const { result } = await platformApi.testSap(clientId, environment);
    return result.ok ? `Connection succeeded: ${result.message}` : `Connection failed: ${result.message}`;
  }).catch(() => {});

  const promote = (environment) => {
    const reason = window.prompt(
      `Point this tenant's live traffic at its ${environment} SAP connection?\n\nReason (recorded in the audit trail):`
    );
    if (reason === null) return;
    act(async () => {
      await platformApi.promoteSap(clientId, environment, reason);
      return `This tenant now runs against ${environment}.`;
    }).catch(() => {});
  };

  if (loading && !data) return <Loading label="Loading SAP configuration" />;
  if (!data) return <Notice>{error || 'Workspace not found.'}</Notice>;

  return (
    <div>
      <Link href={`/platform/tenants/${clientId}`} className="mb-3 inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-primary">
        <ArrowLeft className="size-3.5" /> {data.companyName}
      </Link>

      <PageHeader
        title="SAP connection"
        caption={`${data.clientId} · running against ${data.activeEnvironment}`}
      />

      <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>
      <Notice onDismiss={() => setFailure('')}>{failure || error}</Notice>

      <div className="grid gap-5 lg:grid-cols-2">
        {data.connections.map(({ environment, connection }) => (
          <ConnectionCard
            key={environment}
            environment={environment}
            connection={connection}
            drivers={data.drivers}
            busy={busy}
            canConfigure={canConfigure}
            onSave={save}
            onTest={test}
            onPromote={promote}
          />
        ))}
      </div>

      <section className="mt-5">
        <h2 className="mb-3 text-[15px] font-semibold text-text-primary">Change history</h2>
        <Table
          columns={[
            { key: 'at', header: 'When', render: (row) => <span className="mono text-text-secondary">{formatDate(row.at)}</span> },
            { key: 'action', header: 'Action' },
            { key: 'environment', header: 'Environment' },
            { key: 'driver', header: 'Driver' },
            {
              key: 'detail',
              header: 'Detail',
              render: (row) => (
                <span className="text-[11px] text-text-secondary">
                  {[
                    ...Object.entries(row.changes || {}).map(([field, change]) => `${field}: ${change.from ?? '—'} → ${change.to ?? '—'}`),
                    ...(row.secretsChanged?.length ? [`credentials set: ${row.secretsChanged.join(', ')}`] : []),
                    ...(row.result ? [row.result.ok ? 'test passed' : `test failed — ${row.result.message}`] : []),
                  ].join(' · ') || '—'}
                </span>
              ),
            },
            { key: 'actorEmail', header: 'Who', render: (row) => <span className="mono text-text-secondary">{row.actorEmail || 'system'}</span> },
          ]}
          rows={(trail.data?.entries || []).map((entry) => ({ ...entry, key: entry.pk }))}
          empty="Nothing has been configured yet."
        />
      </section>
    </div>
  );
}
