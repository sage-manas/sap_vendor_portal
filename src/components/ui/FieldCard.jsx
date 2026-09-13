'use client';

import { Children, cloneElement, isValidElement, useId } from 'react';

// The labelled-field wrapper the supplier forms are built from.
//
// It existed twice, byte for byte, in RfqView and RegistrationView, and in
// neither copy was the label attached to anything: no `htmlFor`, and the
// control was the label's *sibling*, so there was no implicit association
// either. Visually correct, programmatically silent — a screen reader
// announced "edit, blank" for every priced line on a quotation, and clicking a
// label did not focus its field.
//
// This owns that association, so a form cannot forget it.

// Elements a <label for> can actually point at. A label pointing at a <div>
// is the same non-association we started with, only harder to notice.
const LABELABLE = new Set(['input', 'select', 'textarea', 'button', 'meter', 'output', 'progress']);

/**
 * Attaches `id` (plus the aria state) to the control inside `node`.
 *
 * Call sites do not all hand over a bare input: several wrap one in a div for
 * width or for a positioned adornment, so this descends through plain wrapper
 * elements to find the control. A custom component is handed the props and is
 * expected to forward them — see SearchableSelect and DocumentUploadZone,
 * which do.
 *
 * Returns `[node, associated]` so the caller can tell whether it worked.
 */
const attach = (node, props) => {
  if (!isValidElement(node)) return [node, false];

  const { type } = node;

  if (typeof type === 'string') {
    if (LABELABLE.has(type)) return [cloneElement(node, props), true];

    // A plain wrapper — descend. Only the first control found is labelled;
    // a wrapper holding two controls needs two fields, not one.
    let associated = false;
    const children = Children.map(node.props.children, (child) => {
      if (associated) return child;
      const [next, done] = attach(child, props);
      associated = done;
      return next;
    });
    return associated ? [cloneElement(node, undefined, children), true] : [node, false];
  }

  // A component: hand it the props and trust it to forward them. Verified at
  // runtime below — if it drops them, the dev warning fires.
  return [cloneElement(node, props), true];
};

/**
 * A labelled form field.
 *
 * @param {string}  label      visible label text, also its accessible name
 * @param {boolean} [required]
 * @param {string}  [error]    validation message; also sets aria-invalid
 * @param {string}  [hint]     help text, shown when there is no error
 * @param {string}  [className] the caller's input-styling overrides. Kept a
 *   prop rather than baked in: the two forms this replaced injected slightly
 *   different utility strings, and folding them together would have changed
 *   how one of them looks.
 */
/**
 * Labels a control, for a card that renders its own layout.
 *
 * The purchase-order forms use a visually different card (boxed, with an
 * icon), and there is no reason for it to reimplement the association — this
 * is the part worth sharing, not the markup.
 *
 * @returns `{ id, control }` — put `id` on the <label htmlFor>, render `control`.
 */
export function useLabelledControl({ label, required, error, hint, children }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;

  const [control, associated] = attach(children, {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    'aria-required': required || undefined,
  });

  if (process.env.NODE_ENV !== 'production' && !associated) {
    // Loud on purpose. A field that silently fails to associate is exactly the
    // defect this exists to prevent, and it is invisible on screen.
    console.error(
      `[FieldCard] Could not attach a label to the control for "${label}". ` +
      'Its child is not a labelable element and no labelable descendant was found — ' +
      'the field will be announced without a name.'
    );
  }

  return { id, control, describedBy };
}

export default function FieldCard({ label, required, error, hint, className = '', children }) {
  const { id, control } = useLabelledControl({ label, required, error, hint, children });

  return (
    <div className={`flex items-start gap-1.5 select-none w-full ${className}`}>
      <label htmlFor={id} className="text-[13px] font-semibold text-text-secondary shrink-0 w-28 pt-1.5" title={label}>
        {/* Decorative: requiredness reaches assistive tech through
            aria-required on the control, so the asterisk is excluded from
            the accessible name rather than read out as "star". */}
        {label} {required && <span aria-hidden="true" className="text-rose-500 font-bold ml-0.5">*</span>}
      </label>
      <div className="flex-1 flex flex-col min-w-0">
        {control}
        {hint && !error && (
          <span id={`${id}-hint`} className="text-[11px] text-text-tertiary mt-1">{hint}</span>
        )}
        {error && (
          <span id={`${id}-error`} className="text-[11px] font-bold text-rose-500 mt-1">{error}</span>
        )}
      </div>
    </div>
  );
}
