'use client';

import { Menu } from '@base-ui/react/menu';
import { ArrowDown, ArrowUp, ChevronRight, Columns3 } from 'lucide-react';
import { Checkbox, DropdownMenu } from './controls';
import TableSkeleton from './TableSkeleton';

/**
 * The table every list screen should be built on.
 *
 * columns: [{
 *   key, header,
 *   render?(row)        cell content (default: row[key])
 *   align?: 'right'     numbers and money — right-aligned, tabular
 *   mono?: boolean      identifiers (PO-2026-0080, GSTIN) and amounts
 *   sortable?: boolean
 *   width?: string      CSS width
 *   primary?: boolean   the card title on narrow screens
 *   mobile?: false      leave out of the narrow-screen card
 *   wrap?: true         let long text wrap (cells are single-line by default)
 * }]
 *
 * Presentation only: sorting, selection and column visibility are controlled
 * — the screen owns the state and decides what they mean.
 */
export default function DataTable({
  columns,
  rows,
  getRowId = (row, i) => row.id ?? row.key ?? i,
  loading = false,
  empty = 'Nothing here yet.',
  density = 'comfortable',
  sort,
  onSortChange,
  selectable = false,
  selected = [],
  onSelectedChange,
  onRowClick,
  rowLabel = (row) => String(getRowId(row, 0)),
  inlineActions,
  rowActions,
  totals,
  hiddenColumns = [],
  caption,
  className = '',
}) {
  const visible = columns.filter((c) => !hiddenColumns.includes(c.key));
  const ids = rows.map(getRowId);
  const allSelected = ids.length > 0 && ids.every((id) => selected.includes(id));
  const someSelected = !allSelected && ids.some((id) => selected.includes(id));
  const hasActions = Boolean(inlineActions || rowActions || onRowClick);
  const colCount = visible.length + (selectable ? 1 : 0) + (hasActions ? 1 : 0);
  const rowH = density === 'compact' ? 'h-9' : 'h-10';

  const toggle = (id) => onSelectedChange?.(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const toggleAll = () => onSelectedChange?.(allSelected ? [] : ids);

  const cell = (col, row) => {
    const value = col.render ? col.render(row) : row[col.key];
    return col.mono ? <span className="mono">{value}</span> : value;
  };

  const sortHeader = (col) => {
    const active = sort?.key === col.key;
    const dir = active ? sort.dir : undefined;
    if (!col.sortable) return col.header;
    return (
      <button
        type="button"
        onClick={() => onSortChange?.({ key: col.key, dir: active && dir === 'asc' ? 'desc' : 'asc' })}
        className={`inline-flex items-center gap-1 hover:text-fg cursor-pointer ${col.align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-fg' : ''}`}
      >
        {col.header}
        {active && (dir === 'asc' ? <ArrowUp className="size-3.5" strokeWidth={1.5} aria-hidden="true" /> : <ArrowDown className="size-3.5" strokeWidth={1.5} aria-hidden="true" />)}
      </button>
    );
  };

  return (
    <div className={`rounded-lg border border-border bg-surface ${className}`}>
      {/* ≥ 768px: a real table */}
      <div className="hidden md:block overflow-x-auto rounded-lg">
        <table className="w-full border-collapse">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10">
            <tr>
              {selectable && (
                <th className="w-10 pr-0">
                  <Checkbox checked={allSelected} indeterminate={someSelected} onCheckedChange={toggleAll} aria-label="Select all rows" />
                </th>
              )}
              {visible.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={col.align === 'right' ? 'text-right' : undefined}
                  aria-sort={sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sortHeader(col)}
                </th>
              ))}
              {hasActions && <th className="w-px"><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr className="hover:[&>td]:bg-transparent"><td colSpan={colCount} className="p-0"><TableSkeleton rows={5} cols={Math.min(visible.length, 6)} /></td></tr>
            ) : rows.length === 0 ? (
              <tr className="hover:[&>td]:bg-transparent"><td colSpan={colCount} className="text-fg-muted">{empty}</td></tr>
            ) : rows.map((row, i) => {
              const id = getRowId(row, i);
              const isSel = selected.includes(id);
              return (
                <tr
                  key={id}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  aria-selected={selectable ? isSel : undefined}
                  className={`group ${onRowClick ? 'cursor-pointer' : ''} ${isSel ? '[&>td]:bg-accent-tint' : ''}`}
                >
                  {selectable && (
                    <td className={`${rowH} w-10 py-0 pr-0`} onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={isSel} onCheckedChange={() => toggle(id)} aria-label={`Select ${rowLabel(row)}`} />
                    </td>
                  )}
                  {visible.map((col) => (
                    <td key={col.key} className={`${rowH} py-0 ${col.wrap ? '' : 'whitespace-nowrap'} ${col.align === 'right' ? 'text-right' : ''}`}>
                      {cell(col, row)}
                    </td>
                  ))}
                  {hasActions && (
                    <td className={`${rowH} py-0 pl-0 text-right whitespace-nowrap`} onClick={(e) => e.stopPropagation()}>
                      <span className="inline-flex items-center gap-1">
                        {inlineActions && (
                          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            {inlineActions(row)}
                          </span>
                        )}
                        {rowActions && <DropdownMenu items={rowActions(row)} label={`Actions for ${rowLabel(row)}`} />}
                        {!rowActions && onRowClick && (
                          <button type="button" onClick={() => onRowClick(row)} aria-label={`Open ${rowLabel(row)}`} className="grid size-8 place-items-center rounded-md text-fg-subtle hover:bg-subtle hover:text-fg cursor-pointer">
                            <ChevronRight className="size-4" strokeWidth={1.5} />
                          </button>
                        )}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {totals && !loading && rows.length > 0 && (
            <tfoot>
              <tr>
                {selectable && <td className="border-t border-border bg-subtle" />}
                {visible.map((col, i) => (
                  <td key={col.key} className={`border-t border-border bg-subtle font-semibold whitespace-nowrap ${col.align === 'right' ? 'text-right' : ''}`}>
                    {totals[col.key] != null
                      ? (col.mono ? <span className="mono">{totals[col.key]}</span> : totals[col.key])
                      : i === 0 ? totals.label : null}
                  </td>
                ))}
                {hasActions && <td className="border-t border-border bg-subtle" />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* < 768px: one card per row */}
      <ul className="md:hidden divide-y divide-border" aria-label={caption}>
        {loading ? (
          <li><TableSkeleton rows={4} cols={2} /></li>
        ) : rows.length === 0 ? (
          <li className="px-4 py-4 text-sm text-fg-muted">{empty}</li>
        ) : rows.map((row, i) => {
          const id = getRowId(row, i);
          const primary = visible.find((c) => c.primary) || visible[0];
          const rest = visible.filter((c) => c !== primary && c.mobile !== false);
          return (
            <li key={id} className="flex gap-3 px-4 py-3">
              {selectable && (
                <div className="pt-0.5"><Checkbox checked={selected.includes(id)} onCheckedChange={() => toggle(id)} aria-label={`Select ${rowLabel(row)}`} /></div>
              )}
              <div
                className={`min-w-0 flex-1 ${onRowClick ? 'cursor-pointer' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                <div className="text-sm font-medium text-fg">{cell(primary, row)}</div>
                <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {rest.map((col) => (
                    <div key={col.key} className="contents">
                      <dt className="text-fg-subtle">{col.header}</dt>
                      <dd className="min-w-0 text-fg">{cell(col, row)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {rowActions && <DropdownMenu items={rowActions(row)} label={`Actions for ${rowLabel(row)}`} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Columns" menu for a table toolbar: toggles entries in `hidden`. */
export function ColumnsMenu({ columns, hidden = [], onHiddenChange }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="btn btn-o h-8!">
        <Columns3 className="size-4" strokeWidth={1.5} /> Columns
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-48 rounded-lg border border-border bg-surface p-1 text-sm shadow-popover outline-none">
            {columns.map((col) => (
              <Menu.CheckboxItem
                key={col.key}
                checked={!hidden.includes(col.key)}
                onCheckedChange={(on) => onHiddenChange?.(on ? hidden.filter((k) => k !== col.key) : [...hidden, col.key])}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 outline-none data-[highlighted]:bg-subtle"
              >
                <span className="grid size-4 place-items-center rounded-[4px] border border-input-border">
                  <Menu.CheckboxItemIndicator className="size-2 rounded-[2px] bg-accent-solid" />
                </span>
                {col.header}
              </Menu.CheckboxItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
