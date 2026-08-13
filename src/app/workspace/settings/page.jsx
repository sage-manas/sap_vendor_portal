'use client';

import React, { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { useWorkspaceSession } from '@/lib/workspace-session';
import { PageHeader, Notice, Loading, useResource } from '@/components/console/primitives';

// Workspace settings, rendered entirely from the registry the API serves. This
// screen knows how to draw a boolean, a number and a string — it does not know
// which settings exist, what they default to, or what they are called. Adding
// one to backend/config/tenantSettings.js is the whole change.

const Control = ({ setting, value, onChange, disabled }) => {
  if (setting.type === 'boolean') {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={value}
        disabled={disabled}
        onClick={() => onChange(!value)}
        className={`h-6 w-11 border transition-colors ${value ? 'border-transparent bg-emerald-500/80' : 'border-border-em bg-surface2'}`}
      >
        <span className={`block size-4 bg-surface transition-transform ${value ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    );
  }

  if (setting.type === 'number') {
    return (
      <input
        type="number"
        min="0"
        className="mono h-9 w-40 text-right"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
      />
    );
  }

  return (
    <input
      className="h-9 w-72"
      type={setting.type === 'url' ? 'url' : 'text'}
      placeholder={setting.type === 'color' ? '#2f6f4e' : ''}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
};

export default function SettingsPage() {
  const { refresh } = useWorkspaceSession();
  const { data, error, loading, reload, setError } = useResource(() => apiClient.get('/workspace/settings'));

  // Only what the administrator has actually touched is sent, so two people
  // editing different groups do not overwrite each other.
  const [edits, setEdits] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');

  if (loading) return <Loading label="Loading settings" />;

  const valueOf = (setting) => (setting.key in edits ? edits[setting.key] : setting.value);
  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const res = await apiClient.patch('/workspace/settings', { settings: edits });
      setEdits({});
      setDone(res.changed.length ? `Saved: ${res.changed.join(', ')}.` : 'Nothing had changed.');
      reload();
      // Branding and feature flags decide what the chrome renders, so the
      // session has to hear about this too.
      refresh();
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.errors || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" caption={`How ${data.workspace.companyName} works — for its staff and for its suppliers.`}>
        <button type="button" className="btn btn-o h-9" disabled={!dirty || busy} onClick={() => setEdits({})}>
          Discard
        </button>
        <button type="button" className="btn btn-v h-9" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </PageHeader>

      <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice>
      <Notice tone="success" onDismiss={() => setDone('')}>{done}</Notice>

      <div className="space-y-8">
        {data.groups.map((group) => (
          <section key={group.key}>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">{group.label}</h2>
            <p className="mb-3 mt-1 text-[12px] text-text-secondary">{group.caption}</p>

            <div className="border border-border">
              {group.settings.map((setting) => (
                <div key={setting.key} className="flex items-start justify-between gap-6 border-b border-border p-4 last:border-0">
                  <div className="min-w-0">
                    <p className="text-[13px] text-text-primary">{setting.label}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-text-tertiary">{setting.hint}</p>
                    <p className="mono mt-1 text-[10px] text-text-tertiary">{setting.key}</p>
                    {fieldErrors[setting.key] && (
                      <p className="mt-1 text-[11px] text-rose-400">{fieldErrors[setting.key]}</p>
                    )}
                  </div>

                  <div className="shrink-0 pt-1">
                    <Control
                      setting={setting}
                      value={valueOf(setting)}
                      disabled={busy}
                      onChange={(value) => {
                        setDone('');
                        setEdits((prev) => ({ ...prev, [setting.key]: value }));
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
