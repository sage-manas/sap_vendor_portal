export default function KPICard({ label, value, delta, sub, icon: Icon, className = '' }) {
  return (
    <div className={`metric-panel animate-fadeUp ${className}`}>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {Icon && (
          <span className="flex items-center justify-center size-7 rounded-lg" style={{ backgroundColor: 'var(--color-emerald-dim)' }}>
            <Icon className="size-3.5 text-emerald-text" />
          </span>
        )}
      </div>
      <span className="text-[28px] leading-none font-semibold tracking-[-0.01em] tabular-nums text-text-primary mt-1">{value}</span>
      {(delta || sub) && (
        <div className="flex items-center gap-1.5 mt-1.5">
          {delta && <span className="text-[11px] font-semibold text-emerald-text">{delta}</span>}
          {sub && <span className="text-[11px] text-text-tertiary">{sub}</span>}
        </div>
      )}
    </div>
  );
}
