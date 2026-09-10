'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';

// The back-office vocabulary, shared by the platform console and the tenant
// workspace. Two planes, two navs, two sessions — but one set of tables,
// headers and notices, because a second copy would be the place the design
// system quietly forks.
//
// Follows the shared token system in globals.css ("Slate & Copper"): bordered
// surfaces with real radius, mono for tabular data, restrained shadows —
// same language as the supplier portal's `.card`/`.status-badge` classes.

export const PageHeader = ({ title, caption, children }) => (
  <div className="mb-5 flex items-start justify-between gap-4 border-b border-border pb-4">
    <div>
      <h1 className="page-title">{title}</h1>
      {caption && <p className="mt-1 text-[13px] text-text-secondary">{caption}</p>}
    </div>
    {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
  </div>
);

export const Notice = ({ tone = 'error', children, onDismiss }) => {
  if (!children) return null;
  const tones = {
    error: 'border-rose-500/50 bg-rose-500/10 text-rose-400',
    success: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-text',
    info: 'border-border-em text-text-secondary',
  };

  return (
    <div role="status" className={`mb-4 flex items-start gap-2.5 rounded-lg border p-3 text-xs ${tones[tone]}`}>
      {tone === 'error' && <AlertCircle className="mt-0.5 size-4 shrink-0" />}
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss"><X className="size-3.5" /></button>
      )}
    </div>
  );
};

export const Field = ({ label, hint, children, ...props }) => (
  <div>
    <label className="label">{label}</label>
    {children || <input className="w-full" {...props} />}
    {hint && <p className="mt-1.5 text-[11px] text-text-tertiary">{hint}</p>}
  </div>
);

// Tenant and operator statuses share one visual language, so they share one
// component rather than each screen inventing its own colours.
const STATUS_TONE = {
  Active: 'status-badge-active',
  Trial: 'status-badge-trial',
  Suspended: 'status-badge-suspended',
  Terminated: 'status-badge-revoked',
  // Supplier lifecycle (backend/config/statuses.js)
  Approved: 'status-badge-active',
  Rejected: 'status-badge-revoked',
  'Under Review': 'status-badge-warn',
  'Pending Approval': 'status-badge-warn',
  Pending: 'status-badge-pending',
  Draft: 'status-badge-pending',
  healthy: 'status-badge-active',
  degraded: 'status-badge-warn',
  failing: 'status-badge-suspended',
  unknown: 'status-badge-pending',
  // Dual identity / sync state (backend/config/statuses.js SAP_SYNC_STATE) —
  // the reconciliation queue's own vocabulary.
  Synced: 'status-badge-active',
  Local: 'status-badge-pending',
  Failed: 'status-badge-suspended',
  Orphaned: 'status-badge-suspended',
};

export const Status = ({ value }) => (
  <span className={`status-badge ${STATUS_TONE[value] || 'status-badge-pending'}`}>{value}</span>
);

export const Table = ({ columns, rows, empty = 'Nothing here yet.', onRowClick }) => (
  <div className="card overflow-hidden">
    <table className="w-full border-collapse">
      <thead className="table-sticky">
        <tr className="border-b border-border bg-surface2">
          {columns.map((column) => (
            <th key={column.key} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.05em] text-text-tertiary">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-xs text-text-tertiary">{empty}</td></tr>
        ) : rows.map((row, index) => (
          <tr
            key={row.key ?? index}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`border-b border-border last:border-0 hover:bg-surface2 ${onRowClick ? 'cursor-pointer' : ''}`}
          >
            {columns.map((column) => (
              <td key={column.key} className="px-3 py-2 align-middle text-[13px]">
                {column.render ? column.render(row) : <span className="mono">{row[column.key]}</span>}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Loading = ({ label = 'Loading' }) => (
  <div className="flex items-center gap-2 py-10 text-xs text-text-tertiary">
    <Loader2 className="size-4 animate-spin" /> {label}…
  </div>
);

/**
 * The load-and-refresh pattern every console screen uses: call the API, hold
 * data, error and a busy flag, and expose a `reload`.
 *
 * `key` is a string identifying *what* is being loaded — a query string, a
 * clientId — and the resource reloads whenever it changes. The loader itself is
 * read through a ref, so a screen can close over fresh state without the
 * closure identity re-triggering a fetch on every render.
 */
export const useResource = (loader, key = '') => {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));

    (async () => {
      try {
        const data = await loaderRef.current();
        // A screen the operator has already navigated away from must not write
        // its result over the one they are now looking at.
        if (!cancelled) setState({ data, error: '', loading: false });
      } catch (err) {
        if (!cancelled) setState((prev) => ({ ...prev, error: err.message, loading: false }));
      }
    })();

    return () => { cancelled = true; };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const setError = useCallback((error) => setState((prev) => ({ ...prev, error })), []);

  return { ...state, reload, setError };
};

export const formatDate = (value) =>
  (value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
