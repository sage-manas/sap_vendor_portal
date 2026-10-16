// Empty is quiet and points to the next step. Never a dashed box.
//
// Default: a compact block (≤ 120px). `inline`: one line, for inside a panel.
// For an empty table, pass `empty` to DataTable — the message sits in the body.

export default function EmptyState({ icon: Icon, title = 'No data', description, action, inline = false, className = '' }) {
  if (inline) {
    return (
      <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 py-3 text-sm text-fg-muted ${className}`}>
        {Icon && <Icon className="size-4 text-fg-subtle" aria-hidden="true" />}
        <span className="text-fg">{title}</span>
        {description && <span>{description}</span>}
        {action}
      </p>
    );
  }
  return (
    <div className={`flex items-start gap-3 px-4 py-6 ${className}`}>
      {Icon && <Icon className="mt-0.5 size-5 shrink-0 text-fg-subtle" aria-hidden="true" />}
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description && <p className="mt-0.5 max-w-[60ch] text-sm text-fg-muted">{description}</p>}
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}

