import Link from 'next/link';
import StatusBadge from './StatusBadge';
import { Avatar } from './controls';

// Dashboard vocabulary for redesign v2 ("Ledger Night",
// docs/redesign/04-redesign-v2-plan.md §1). Dashboards and detail headers
// only — list pages keep DataTable.

const cx = (...c) => c.filter(Boolean).join(' ');

/* ── DeltaChip: a small round change marker beside a hero figure ────────── */
const DELTA_TONE = {
  up: 'bg-success-tint text-success',
  down: 'bg-danger-tint text-danger',
  warn: 'bg-warning-tint text-warning',
  neutral: 'bg-subtle text-fg-muted',
};
export function DeltaChip({ value, tone = 'neutral', label, className = '' }) {
  return (
    <span
      className={cx('inline-flex h-6 items-center rounded-pill px-2 text-xs font-medium tabular-nums', DELTA_TONE[tone] || DELTA_TONE.neutral, className)}
      aria-label={label}
    >
      {value}
    </span>
  );
}

/* ── MeterPillRow: a row of labelled percentage pills ───────────────────
   Each pill's width follows its value, so the row reads as a proportion at
   a glance; the percentage is always printed, so colour and hatching are
   never the only signal. */
const PILL_VARIANT = {
  solid: 'bg-accent-solid text-accent-fg',
  inverse: 'bg-fg text-canvas',
  muted: 'bg-subtle text-fg border border-border',
  hatched: 'meter-pill-hatched text-fg border border-border',
};
export function MeterPillRow({ items, className = '' }) {
  return (
    <div className={cx('flex flex-wrap gap-x-2 gap-y-3', className)}>
      {items.map(({ label, value, max = 100, variant = 'muted', format = (v) => `${v}%` }) => {
        const pct = Math.max(0, Math.min(100, (value / max) * 100));
        return (
          <div key={label} className="flex min-w-[88px] flex-col gap-1.5" style={{ flex: `${Math.max(pct, 12)} 1 0` }}>
            <span className="truncate text-sm text-fg-muted">{label}</span>
            <span
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={max}
              aria-valuenow={value}
              aria-valuetext={format(value)}
              className={cx('flex h-9 items-center rounded-pill px-4 text-sm font-medium tabular-nums', PILL_VARIANT[variant] || PILL_VARIANT.muted)}
            >
              {format(value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ── StatTile: a labelled count, optionally a link ──────────────────────── */
const DOT = { accent: 'bg-accent-solid', info: 'bg-info', success: 'bg-success', warn: 'bg-warning', danger: 'bg-danger', neutral: 'bg-fg-subtle' };
export function StatTile({ label, count, tone = 'neutral', href, className = '' }) {
  const body = (
    <>
      <span className={cx('size-2 shrink-0 rounded-full', DOT[tone] || DOT.neutral)} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{label}</span>
      <span className="rounded-pill bg-surface px-2.5 py-0.5 text-xs font-medium tabular-nums text-fg border border-border">{count}</span>
    </>
  );
  const cls = cx('flex h-12 items-center gap-3 rounded-tile border border-border bg-subtle px-4', className);
  return href
    ? <Link href={href} className={cx(cls, 'transition-colors hover:border-border-strong')}>{body}</Link>
    : <div className={cls}>{body}</div>;
}

/* ── RecordCard: one PO / invoice / RFQ / approval as a card ────────────
   Status top-left, identifier and age top-right, a line of context, and
   the person it belongs to. */
export function RecordCard({ status, statusTone, id, age, title, person, href, className = '' }) {
  const body = (
    <>
      <div className="flex items-start gap-3">
        {status && <StatusBadge label={status} tone={statusTone} />}
        <div className="ml-auto text-right text-xs leading-4 text-fg-subtle">
          {id && <div className="mono text-fg-muted">{id}</div>}
          {age && <div>{age}</div>}
        </div>
      </div>
      {title && <p className="mt-3 line-clamp-3 text-sm text-fg">{title}</p>}
      {person && (
        <div className="mt-4 flex items-center gap-2.5">
          <Avatar name={person.name} src={person.src} size={32} />
          <div className="min-w-0 text-xs leading-4">
            <div className="truncate text-sm font-medium text-fg">{person.name}</div>
            {person.detail && <div className="truncate text-fg-subtle">{person.detail}</div>}
          </div>
        </div>
      )}
    </>
  );
  const cls = cx('flex flex-col rounded-tile border border-border bg-subtle p-4', className);
  return href
    ? <Link href={href} className={cx(cls, 'transition-colors hover:border-border-strong')}>{body}</Link>
    : <div className={cls}>{body}</div>;
}
