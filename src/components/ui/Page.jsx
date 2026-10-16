// The one page header, for every surface: optional breadcrumb, title,
// description, one primary action on the right and anything else in an
// overflow menu (pass it as `secondary`).
//
// `Page` wraps content with the header; `PageHeader` is the header alone for
// screens that own their own layout.

export function PageHeader({ breadcrumb, title, description, caption, primary, secondary, action, children, className = '' }) {
  const desc = description ?? caption;
  const right = primary || secondary || action || children;
  return (
    <header className={`mb-6 flex flex-col gap-3 sm:flex-row sm:items-start ${className}`}>
      <div className="min-w-0 flex-1">
        {breadcrumb && <div className="mb-1 text-sm text-fg-subtle">{breadcrumb}</div>}
        <h1 className="page-title">{title}</h1>
        {desc && <p className="mt-0.5 max-w-[72ch] text-sm text-fg-muted">{desc}</p>}
      </div>
      {right && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {children}
          {action}
          {secondary}
          {primary}
        </div>
      )}
    </header>
  );
}

export default function Page({ title, action, children, className = '', ...header }) {
  return (
    <div className={`p-4 md:p-6 ${className}`}>
      {(title || action) && <PageHeader title={title} action={action} {...header} />}
      {children}
    </div>
  );
}
