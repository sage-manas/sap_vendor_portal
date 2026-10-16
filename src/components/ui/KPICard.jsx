// A figure with its label — and, when it helps, a delta, a sparkline or a link.
//
// No coloured rail, no icon chip: four KPIs side by side are told apart by
// their labels. A zero is not signal, so it renders muted and smaller, with
// the hint carrying the meaning ("Nothing outstanding") instead of a hero "0".
//
// `icon` and `tone` are accepted for backward compatibility and ignored.

const isZero = (value) => {
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return /^[^\d]*0+([.,]0+)?[^\d]*$/.test(value.trim());
  return false;
};

export default function KPICard({
  label,
  value,
  delta,
  deltaTone = 'neutral',
  sub,
  hint,
  spark,
  href,
  onClick,
  linkLabel,
  empty,
  className = '',
  // eslint-disable-next-line no-unused-vars
  icon, tone,
}) {
  const muted = empty ?? isZero(value);
  const note = hint ?? sub;
  const deltaClass = { up: 'text-success', down: 'text-danger', neutral: 'text-fg-muted' }[deltaTone] || 'text-fg-muted';

  return (
    <div className={`metric-panel ${className}`}>
      <span className="text-sm text-fg-muted">{label}</span>
      <span
        className={muted
          ? 'text-xl font-normal text-fg-subtle tabular-nums mt-1'
          : 'text-2xl font-semibold tracking-[-0.01em] text-fg tabular-nums mt-1'}
      >
        {value}
      </span>
      {(delta || note) && (
        <span className="flex items-center gap-1.5 text-xs text-fg-subtle">
          {delta && <span className={`font-medium ${deltaClass}`}>{delta}</span>}
          {note && <span>{note}</span>}
        </span>
      )}
      {spark && <div className="mt-1.5">{spark}</div>}
      {(href || onClick) && linkLabel && (
        href
          ? <a href={href} className="mt-1 text-xs font-medium text-accent-text hover:underline w-fit">{linkLabel}</a>
          : <button type="button" onClick={onClick} className="mt-1 text-xs font-medium text-accent-text hover:underline w-fit text-left cursor-pointer">{linkLabel}</button>
      )}
    </div>
  );
}

/**
 * A row of KPIs sharing one border — the strip the redesign uses instead of
 * four separate cards. Children are KPICards; their own borders are dropped.
 */
export function KPIStrip({ children, className = '' }) {
  return (
    // Columns follow the strip's own width (container query), not the
    // viewport's — a strip in a half-width panel must not clip "₹4,07,936.50".
    <div className={`@container overflow-hidden rounded-lg border border-border bg-surface ${className}`}>
      <div
        className="grid grid-cols-2 @3xl:grid-cols-4
          [&>.metric-panel]:rounded-none [&>.metric-panel]:border-0 [&>.metric-panel]:border-border
          [&>.metric-panel:not(:first-child)]:border-l [&>.metric-panel:nth-child(odd)]:border-l-0 @3xl:[&>.metric-panel:nth-child(odd)]:border-l
          [&>.metric-panel:nth-child(n+3)]:border-t @3xl:[&>.metric-panel:nth-child(n+3)]:border-t-0 [&>.metric-panel:first-child]:border-l-0"
      >
        {children}
      </div>
    </div>
  );
}

/** A tiny trend line. `points` is an array of numbers. */
export function Sparkline({ points = [], width = 120, height = 20, label }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const xy = points.map((p, i) => [i * step, height - 2 - ((p - min) / span) * (height - 4)]);
  const last = xy[xy.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label || 'Trend'}>
      <polyline points={xy.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--fg-muted)" strokeWidth="1.5" />
      <circle cx={last[0]} cy={last[1]} r="2" fill="var(--fg)" />
    </svg>
  );
}
