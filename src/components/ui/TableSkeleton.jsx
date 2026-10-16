// Placeholder rows shaped like the table they stand in for. Widths vary per
// row so it does not read as a grid of identical bars.
export default function TableSkeleton({ rows = 6, cols = 5 }) {
  return (
    <div className="w-full" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-10 items-center gap-4 border-b border-border px-3 last:border-b-0">
          {Array.from({ length: cols }).map((__, c) => (
            <div
              key={c}
              className="skeleton h-3"
              style={{ width: `${c === 0 ? 14 : Math.max(8, 100 / cols - ((r * 7 + c * 5) % 9))}%`, marginLeft: c === cols - 1 ? 'auto' : undefined }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
