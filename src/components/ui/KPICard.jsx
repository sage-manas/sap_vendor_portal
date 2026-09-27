// Tone maps to a semantic color already defined in globals.css (status dots /
// badges use the same palette), so a KPI card never introduces a new hue —
// it just borrows the one that already means "attention", "in progress" or
// "done" everywhere else in the app.
const TONES = {
  primary: { fg: 'text-emerald-text', bg: 'var(--color-emerald-dim)', rail: 'rgb(var(--color-emerald-default-rgb))' },
  amber: { fg: 'text-amber-500', bg: 'color-mix(in srgb, #d4a017 14%, transparent)', rail: '#d4a017' },
  info: { fg: 'text-[#5db8a6]', bg: 'color-mix(in srgb, #5db8a6 14%, transparent)', rail: '#5db8a6' },
  success: { fg: 'text-[#5db872]', bg: 'color-mix(in srgb, #5db872 14%, transparent)', rail: '#5db872' },
};

export default function KPICard({ label, value, delta, sub, icon: Icon, tone = 'primary', className = '' }) {
  const t = TONES[tone] || TONES.primary;
  return (
    <div className={`metric-panel animate-fadeUp relative overflow-hidden ${className}`}>
      {/* Slim tone rail on the leading edge — the one cue (besides the icon
          chip) that tells four otherwise-identical cards apart at a glance. */}
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: t.rail }} />
      <div className="flex items-center justify-between pl-1">
        <span className="label">{label}</span>
        {Icon && (
          <span className="flex items-center justify-center size-7 rounded-lg shrink-0" style={{ backgroundColor: t.bg }}>
            <Icon className={`size-3.5 ${t.fg}`} />
          </span>
        )}
      </div>
      <span className="text-[28px] leading-none font-semibold tracking-[-0.01em] tabular-nums text-text-primary mt-1 pl-1">{value}</span>
      {(delta || sub) && (
        <div className="flex items-center gap-1.5 mt-1.5 pl-1">
          {delta && <span className={`text-[11px] font-semibold ${t.fg}`}>{delta}</span>}
          {sub && <span className="text-[11px] text-text-tertiary">{sub}</span>}
        </div>
      )}
    </div>
  );
}
