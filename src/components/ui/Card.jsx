// A surface. Use one only when the grouping carries meaning — a page section
// does not need a box around it.

export default function Card({ children, className = '', ...props }) {
  return (
    <div className={`card ${className}`} {...props}>
      {children}
    </div>
  );
}

/** Title row for a Card: heading, optional description, optional actions. */
export function CardHeader({ title, description, actions, className = '' }) {
  return (
    <div className={`flex items-start gap-3 px-4 py-3 border-b border-border ${className}`}>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {description && <p className="text-sm text-fg-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * An unboxed page section: heading + content. What most "cards" on a page
 * should have been.
 */
export function Section({ title, description, actions, children, className = '' }) {
  return (
    <section className={`mt-8 first:mt-0 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-lg font-semibold text-fg">{title}</h2>}
            {description && <p className="text-sm text-fg-muted mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
