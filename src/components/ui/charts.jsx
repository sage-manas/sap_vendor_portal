'use client';

// Charts for the reports screens, styled per the dataviz method
// (docs/redesign/design-system.md § Charts):
//   - one hue per single-series chart (--chart-series); no legend box, the
//     title names the series
//   - an ordinal ramp (--chart-seq-1..4) for ordered buckets such as ageing
//   - thin marks, 4px rounded data ends, recessive grid and axes, one y-axis
//   - a hover tooltip on every plotted mark; text in text tokens, never the
//     series colour
// Every chart sits beside a table of the same numbers, which is its
// accessible view.

import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

export const inrFull = (value) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ₹45K · ₹1.2L · ₹3.4Cr — Indian units for axis ticks only; tooltips and
// tables carry the exact figure.
export const inrCompact = (value) => {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e7) return `${sign}₹${+(abs / 1e7).toFixed(1)}Cr`;
  if (abs >= 1e5) return `${sign}₹${+(abs / 1e5).toFixed(1)}L`;
  if (abs >= 1e3) return `${sign}₹${+(abs / 1e3).toFixed(0)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
};

const AXIS = { fill: 'var(--chart-axis)', fontSize: 12 };

function ChartTooltip({ active, payload, label, format = inrFull, name }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-popover">
      <p className="text-fg-muted">{label}</p>
      <p className="mono text-sm text-fg">{format(payload[0].value)}{name ? <span className="font-sans text-fg-muted"> {name}</span> : null}</p>
    </div>
  );
}

/** Columns over a discrete axis (months). data: [{ label, value }] */
export function ColumnChart({ data, ariaLabel, height = 220, format = inrFull }) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--chart-grid)' }} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={inrCompact} />
          <Tooltip cursor={{ fill: 'var(--hover)' }} content={<ChartTooltip format={format} />} />
          <Bar dataKey="value" fill="var(--chart-series)" radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A value over time as a step line (a ledger balance changes in steps). */
export function StepLineChart({ data, ariaLabel, height = 220, format = inrFull }) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--chart-grid)' }} minTickGap={24} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={inrCompact} />
          <Tooltip cursor={{ stroke: 'var(--chart-axis)', strokeDasharray: '3 3' }} content={<ChartTooltip format={format} />} />
          <Line
            type="stepAfter"
            dataKey="value"
            stroke="var(--chart-series)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, fill: 'var(--chart-series)', stroke: 'var(--surface)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Ranked horizontal bars in HTML — label, bar, exact value — for categories
 * (material, plant). Direct labels, so no tooltip or legend is needed. Rows
 * past `limit` fold into "Other" rather than shrinking into slivers.
 */
export function RankedBars({ data, limit = 6, format = inrFull, ariaLabel }) {
  const top = data.slice(0, limit);
  const rest = data.slice(limit);
  const rows = rest.length
    ? [...top, { label: `Other (${rest.length})`, value: rest.reduce((s, r) => s + r.value, 0), other: true }]
    : top;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  return (
    <ul aria-label={ariaLabel} className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,10rem)_1fr_9rem] items-center gap-3 text-sm">
          <span className={`truncate ${row.other ? 'text-fg-muted' : 'text-fg'}`} title={row.title || row.label}>{row.label}</span>
          <span className="h-2 rounded-full bg-subtle" aria-hidden="true">
            <span className="block h-2 rounded-full" style={{ width: `${(row.value / max) * 100}%`, background: row.other ? 'var(--chart-axis)' : 'var(--chart-series)' }} />
          </span>
          <span className="mono text-right text-fg">{format(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One bar split into ordered buckets (invoice ageing), with a legend that
 * names every bucket and its amount — the colour is never the only label.
 * buckets: [{ label, value }] in order, youngest first.
 */
export function BucketBar({ buckets, format = inrFull, ariaLabel }) {
  const total = buckets.reduce((s, b) => s + b.value, 0);
  const steps = ['var(--chart-seq-1)', 'var(--chart-seq-2)', 'var(--chart-seq-3)', 'var(--chart-seq-4)'];
  return (
    <div>
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-subtle" role="img" aria-label={ariaLabel}>
        {total > 0 && buckets.map((b, i) => (b.value > 0 ? (
          <span key={b.label} title={`${b.label}: ${format(b.value)}`} style={{ width: `${(b.value / total) * 100}%`, background: steps[i] }} />
        ) : null))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        {buckets.map((b, i) => (
          <div key={b.label}>
            <dt className="flex items-center gap-1.5 text-fg-muted">
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: steps[i] }} aria-hidden="true" />
              {b.label}
            </dt>
            <dd className={`mono mt-0.5 ${b.value > 0 ? 'text-fg' : 'text-fg-subtle'}`}>{format(b.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
