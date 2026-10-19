// A surface. Use one only when the grouping carries meaning — a page section
// does not need a box around it.

// `tone`: default · raised (a step lighter) · accent (the tenant colour — at
// most one per page).
const TONE = { default: '', raised: 'card-raised', accent: 'card-accent' };

export default function Card({ children, tone = 'default', className = '', ...props }) {
  return (
    <div className={`card ${TONE[tone] || ''} ${className}`} {...props}>
      {children}
    </div>
  );
}

/** Title row for a Card: heading, optional description, optional actions. */
export function CardHeader({ title, description, actions, className = '' }) {
  return (
    <div className={`flex items-start gap-3 px-5 pt-5 pb-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-medium">{title}</h2>
        {description && <p className="text-sm opacity-80 mt-0.5">{description}</p>}
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
    <section className={className}>
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
