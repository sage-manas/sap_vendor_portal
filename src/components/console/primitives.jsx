'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronRight, Info, Loader2, X } from 'lucide-react';
import { PageHeader as SharedPageHeader } from '@/components/ui/Page';
import StatusBadge from '@/components/ui/StatusBadge';
import { useLabelledControl } from '@/components/ui/FieldCard';
import { useNarrow } from '@/components/ui/useNarrow';

// The back-office vocabulary, shared by the platform console and the tenant
// workspace. Two planes, two navs, two sessions — but one set of tables,
// headers and notices, because a second copy would be the place the design
// system quietly forks.
//
// Ledger design system (docs/redesign/design-system.md). The header and the
// status vocabulary are the supplier portal's own components, so the three
// surfaces cannot drift apart.

export const PageHeader = ({ title, caption, breadcrumb, children }) => (
  <SharedPageHeader title={title} description={caption} breadcrumb={breadcrumb}>{children}</SharedPageHeader>
);

const NOTICE = {
  error: { cls: 'border-danger/30 bg-danger-tint text-danger', Icon: AlertCircle },
  success: { cls: 'border-success/30 bg-success-tint text-success', Icon: CheckCircle2 },
  // Not an error — nothing has gone wrong — but louder than info: for a
  // consequence the reader needs to weigh before acting, like an action that
  // writes to SAP and cannot be undone from here.
  warn: { cls: 'border-warning/30 bg-warning-tint text-warning', Icon: AlertTriangle },
  info: { cls: 'border-border bg-surface text-fg-muted', Icon: Info },
};

export const Notice = ({ tone = 'error', children, onDismiss }) => {
  if (!children) return null;
  const { cls, Icon } = NOTICE[tone] || NOTICE.info;

  return (
    <div role="status" className={`mb-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${cls}`}>
      <Icon className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0 flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-my-0.5 grid size-6 place-items-center rounded-md opacity-80 hover:opacity-100 cursor-pointer">
          <X className="size-3.5" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
};

// `type="text"` comes first so a caller's own `type` (password, email …)
// still wins. Without any type the field used to miss the input styles in
// globals.css and render borderless (redesign audit §4.2).
//
// The label is attached to its control (htmlFor/id, plus aria-invalid and
// aria-describedby) through the same helper the supplier forms use; it used
// to be a bare <label> beside the input, named nothing.
export const Field = ({ label, hint, error, children, ...props }) => {
  const { id, control } = useLabelledControl({
    label,
    error,
    hint,
    children: children || <input type="text" className="w-full" {...props} />,
  });
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      {control}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-xs text-danger" role="alert">
          <AlertCircle className="mt-px size-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />{error}
        </p>
      )}
      {hint && !error && <p id={`${id}-hint`} className="mt-1.5 text-xs text-fg-subtle">{hint}</p>}
    </div>
  );
};

// Tenant, operator, supplier and sync statuses go through the one shared
// status map (components/ui/status.js), so a state looks the same on every
// surface.
export const Status = ({ value }) => <StatusBadge label={value} variant="pending" />;

/**
 * columns: { key, header, render?, align?: 'right', mono?: boolean }
 * Numeric columns should pass `align: 'right'` so amounts line up. A column
 * without `render` prints its raw value in mono (they are identifiers) unless
 * it passes `mono: false`.
 */
//
// With `onRowClick`, each row also gets a labelled chevron button: the row's
// own click is a pointer shortcut, the button is the keyboard and
// screen-reader way in. `rowLabel(row)` names it ("Open …").
const cellValue = (column, row) => {
  if (column.render) return column.render(row);
  return column.mono === false ? row[column.key] : <span className="mono">{row[column.key]}</span>;
};

// Below 768px a table becomes one card per row (the brief's phone layout):
// the first column is the card's title, the rest are label/value pairs.
const TableCards = ({ columns, rows, empty, onRowClick, rowLabel }) => {
  const [title, ...rest] = columns;
  return (
    <ul className="card divide-y divide-border">
      {rows.length === 0 ? (
        <li className="px-4 py-4 text-sm text-fg-muted">{empty}</li>
      ) : rows.map((row, index) => (
        <li key={row.key ?? index} className="flex gap-3 px-4 py-3">
          <div
            className={`min-w-0 flex-1 ${onRowClick ? 'cursor-pointer' : ''}`}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          >
            <div className="text-sm font-medium text-fg">{cellValue(title, row)}</div>
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              {rest.filter((column) => column.header).map((column) => (
                <div key={column.key} className="contents">
                  <dt className="text-fg-subtle">{column.header}</dt>
                  <dd className="min-w-0 break-words text-fg">{cellValue(column, row)}</dd>
                </div>
              ))}
            </dl>
            {/* Header-less columns are row actions; on a card they sit below. */}
            {rest.filter((column) => !column.header).map((column) => (
              <div key={column.key} className="mt-2">{cellValue(column, row)}</div>
            ))}
          </div>
          {onRowClick && (
            <button
              type="button"
              onClick={() => onRowClick(row)}
              aria-label={`Open ${rowLabel(row)}`}
              className="-mr-2 grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
            >
              <ChevronRight className="size-4" strokeWidth={1.5} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
};

export const Table = ({ empty = 'Nothing here yet.', rowLabel = (row) => String(row.key ?? ''), ...props }) => {
  const narrow = useNarrow();
  const Layout = narrow ? TableCards : TableGrid;
  return <Layout empty={empty} rowLabel={rowLabel} {...props} />;
};

const TableGrid = ({ columns, rows, empty, onRowClick, rowLabel }) => (
  <div className="card overflow-x-auto">
    <table className="w-full border-collapse">
      <thead className="table-sticky">
        <tr>
          {columns.map((column) => (
            <th key={column.key} className={column.align === 'right' ? 'text-right' : undefined}>
              {column.header}
            </th>
          ))}
          {onRowClick && <th><span className="sr-only">Open</span></th>}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td colSpan={columns.length + (onRowClick ? 1 : 0)} className="text-fg-muted">{empty}</td></tr>
        ) : rows.map((row, index) => (
          <tr
            key={row.key ?? index}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={onRowClick ? 'cursor-pointer' : undefined}
          >
            {columns.map((column) => {
              const mono = !column.render && column.mono !== false;
              return (
                <td
                  key={column.key}
                  className={[
                    column.align === 'right' ? 'text-right tabular-nums' : '',
                    // An identifier never breaks mid-token; a number never wraps.
                    mono || column.align === 'right' ? 'whitespace-nowrap' : '',
                  ].filter(Boolean).join(' ') || undefined}
                >
                  {column.render
                    ? column.render(row)
                    : mono ? <span className="mono">{row[column.key]}</span> : row[column.key]}
                </td>
              );
            })}
            {onRowClick && (
              <td className="w-10 py-0 pl-0 text-right">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onRowClick(row); }}
                  aria-label={`Open ${rowLabel(row)}`}
                  className="grid size-8 cursor-pointer place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg"
                >
                  <ChevronRight className="size-4" strokeWidth={1.5} />
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Loading = ({ label = 'Loading' }) => (
  <div className="flex items-center gap-2 py-10 text-sm text-fg-subtle" role="status">
    <Loader2 className="size-4 animate-spin" strokeWidth={1.5} /> {label}…
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

// For a field that is a date, not a moment — e.g. RFQ.deadlineDate, always
// stored at UTC midnight. Run through formatDate, every such field showed an
// identical, meaningless "5:30 am" (00:00 UTC rendered in IST) on every row
// (issue #166). Read the calendar date in UTC rather than the viewer's local
// zone — there's no real time-of-day to convert, and converting one can roll
// the date itself onto the wrong day in a timezone behind UTC.
export const formatDateOnly = (value) =>
  (value ? new Date(value).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'UTC' }) : '—');
