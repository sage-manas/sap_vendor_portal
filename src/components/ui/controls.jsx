'use client';

// Ledger controls built on @base-ui/react. Each one is unstyled behaviour from
// Base UI (focus, keyboard, ARIA) plus the design system's tokens.

import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { Menu } from '@base-ui/react/menu';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Check, ChevronLeft, ChevronRight, Minus, MoreHorizontal } from 'lucide-react';

const cx = (...c) => c.filter(Boolean).join(' ');

/* ── Tabs: underline, never boxed ────────────────────────────────────────
   items: [{ value, label, count? }]. Panels are optional — many screens use
   tabs as a filter and render one list below. */
export function Tabs({ items, value, defaultValue, onValueChange, children, className = '', 'aria-label': ariaLabel }) {
  return (
    <BaseTabs.Root value={value} defaultValue={defaultValue ?? items?.[0]?.value} onValueChange={onValueChange} className={className}>
      <BaseTabs.List aria-label={ariaLabel} className="relative flex gap-5 overflow-x-auto border-b border-border no-scrollbar">
        {items.map((item) => (
          <BaseTabs.Tab
            key={item.value}
            value={item.value}
            className="-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent text-sm text-fg-muted outline-none
              hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent-solid)]
              data-[active]:border-fg data-[active]:font-medium data-[active]:text-fg cursor-pointer"
          >
            {item.label}
            {item.count != null && <span className="mono text-xs text-fg-subtle">{item.count}</span>}
          </BaseTabs.Tab>
        ))}
      </BaseTabs.List>
      {children}
    </BaseTabs.Root>
  );
}
export const TabPanel = ({ value, children, className = '' }) => (
  <BaseTabs.Panel value={value} className={cx('pt-4 outline-none', className)}>{children}</BaseTabs.Panel>
);

/* ── Segmented control: 2–4 mutually exclusive views ─────────────────────── */
export function SegmentedControl({ options, value, onChange, 'aria-label': ariaLabel, size = 'md' }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-md border border-border bg-subtle p-0.5">
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange?.(opt.value)}
            className={cx(
              'rounded-[5px] px-2.5 text-sm transition-colors cursor-pointer',
              size === 'sm' ? 'h-6 text-xs' : 'h-7',
              on ? 'bg-surface font-medium text-fg shadow-[0_0_0_1px_var(--border)]' : 'text-fg-muted hover:text-fg',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Meter: value bar with a visible target tick ─────────────────────────
   Neutral until the target is met — then success. Never a full green bar
   that hides how far off the target a value is. */
export function Meter({ label, value, max = 100, target, format = (v) => `${v}%`, className = '' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const met = target == null || value >= target;
  return (
    <div className={className}>
      <div className="flex items-baseline gap-3 text-sm">
        <span className="flex-1 text-fg">{label}</span>
        <span className="num text-fg">
          {format(value)}
          {target != null && <span className="text-fg-subtle"> / {format(target)}</span>}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={target != null ? `${format(value)}, target ${format(target)}` : format(value)}
        className="relative mt-2 h-1.5 rounded-full bg-subtle"
      >
        <span className={cx('absolute inset-y-0 left-0 rounded-full', met && target != null ? 'bg-success' : 'bg-fg-muted')} style={{ width: `${pct}%` }} />
        {target != null && (
          <span className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-fg" style={{ left: `calc(${(target / max) * 100}% - 1px)` }} aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

/* ── Avatar: initials on a rounded square ───────────────────────────────── */
export function Avatar({ name = '', src, size = 28 }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary user URL
    <img src={src} alt={name} width={size} height={size} className="shrink-0 rounded-md object-cover" />
  ) : (
    <span
      aria-hidden={name ? undefined : true}
      title={name || undefined}
      className="inline-grid shrink-0 place-items-center rounded-md bg-subtle font-medium text-fg-muted"
      style={{ width: size, height: size, fontSize: size <= 24 ? 11 : 12 }}
    >
      {initials}
    </span>
  );
}

/* ── Tooltip: supplementary text only — never the only label ────────────── */
export function Tooltip({ content, children, side = 'top' }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6}>
          <BaseTooltip.Popup className="z-50 max-w-xs rounded-md bg-fg px-2 py-1 text-xs text-canvas shadow-popover data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
export const TooltipProvider = BaseTooltip.Provider;

/* ── Dropdown menu: the overflow ("more actions") pattern ────────────────
   items: [{ label, onClick, destructive?, disabled? } | 'separator'] */
export function DropdownMenu({ items, trigger, label = 'More actions', align = 'end' }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={trigger ? undefined : label}
        className={trigger ? undefined : 'btn btn-g h-8! w-8! p-0! data-[popup-open]:bg-subtle'}
        render={trigger}
      >
        {trigger ? undefined : <MoreHorizontal className="size-4" strokeWidth={1.5} />}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align={align} sideOffset={4} className="z-50">
          <Menu.Popup className="min-w-44 rounded-lg border border-border bg-surface p-1 text-sm shadow-popover outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150">
            {items.map((item, i) => (item === 'separator' ? (
              <div key={`s${i}`} role="separator" className="my-1 h-px bg-border" />
            ) : (
              <Menu.Item
                key={item.label}
                disabled={item.disabled}
                onClick={item.onClick}
                className={cx(
                  'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 outline-none select-none',
                  'data-[highlighted]:bg-subtle data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45',
                  item.destructive ? 'text-danger' : 'text-fg',
                )}
              >
                {item.icon && <item.icon className="size-4 text-fg-subtle" strokeWidth={1.5} />}
                {item.label}
              </Menu.Item>
            )))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/* ── Checkbox / Switch ───────────────────────────────────────────────────── */
export function Checkbox({ checked, indeterminate, onCheckedChange, disabled, 'aria-label': ariaLabel, id }) {
  return (
    <BaseCheckbox.Root
      id={id}
      checked={checked}
      indeterminate={indeterminate}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className="grid size-4 shrink-0 place-items-center rounded-[4px] border border-input-border bg-surface text-accent-fg outline-none
        data-[checked]:border-accent-solid data-[checked]:bg-accent-solid data-[indeterminate]:border-accent-solid data-[indeterminate]:bg-accent-solid
        data-[disabled]:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-solid)] cursor-pointer"
    >
      <BaseCheckbox.Indicator>
        {indeterminate ? <Minus className="size-3" strokeWidth={2.5} /> : <Check className="size-3" strokeWidth={2.5} />}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  );
}

export function Switch({ checked, onCheckedChange, disabled, 'aria-label': ariaLabel, id }) {
  return (
    <BaseSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input-border bg-subtle p-0.5 outline-none transition-colors
        data-[checked]:border-accent-solid data-[checked]:bg-accent-solid data-[disabled]:opacity-45
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-solid)] cursor-pointer"
    >
      <BaseSwitch.Thumb className="block size-3.5 rounded-full bg-fg-subtle shadow-sm transition-transform data-[checked]:translate-x-4 data-[checked]:bg-accent-fg" />
    </BaseSwitch.Root>
  );
}

/* ── Pagination ─────────────────────────────────────────────────────────── */
export function Pagination({ page, pageCount, total, pageSize, onPageChange }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pagination" className="flex items-center gap-3 px-3 py-2 text-sm text-fg-muted">
      <span className="flex-1"><span className="num">{from}–{to}</span> of <span className="num">{total}</span></span>
      <button type="button" className="btn btn-g h-7! w-7! p-0!" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
        <ChevronLeft className="size-4" strokeWidth={1.5} />
      </button>
      <span className="num text-fg">{page} / {pageCount}</span>
      <button type="button" className="btn btn-g h-7! w-7! p-0!" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)} aria-label="Next page">
        <ChevronRight className="size-4" strokeWidth={1.5} />
      </button>
    </nav>
  );
}
