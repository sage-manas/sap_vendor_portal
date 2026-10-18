'use client';

import React from 'react';
import { Building2 } from 'lucide-react';
import { brandMark } from '@/lib/branding';

// The square mark: a tenant's logo when it has one, else the product's own.
function Mark({ logo, name }) {
  if (logo) {
    // A tenant's logo is an arbitrary remote URL chosen at runtime, so it
    // cannot go through next/image's configured-domains optimiser.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt={`${name} logo`} className="mb-4 h-10 max-w-[180px] object-contain" />;
  }
  return (
    <div
      className="mb-4 flex size-10 shrink-0 items-center justify-center rounded-lg"
      style={{ backgroundColor: 'var(--accent-solid)', color: 'var(--accent-fg)' }}
      aria-hidden="true"
    >
      <Building2 className="size-5" strokeWidth={1.5} />
    </div>
  );
}

/**
 * The mark at the top of a signed-out screen: whose workspace this is.
 *
 * A supplier arrives at their buyer's address, not at ours, so the buyer's name
 * is the heading and VendorConnect is the caption underneath. Before the realm
 * answers, `workspace` is null and this falls back to the product's own mark —
 * the same thing an unbranded tenant shows.
 *
 * `naming` is the line that says, in words rather than in branding, which
 * workspace this screen belongs to. A tenant's logo is optional and its accent
 * colour is optional, so neither can be what tells a supplier whose portal they
 * are agreeing to join (#255); this line is not optional when a workspace
 * resolved.
 */
export default function WorkspaceBrand({ workspace, caption, naming }) {
  const { logo, name } = brandMark(workspace);

  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <Mark logo={logo} name={name} />
      <h1 className="text-xl font-semibold text-fg">{name}</h1>
      <p className="mt-1 text-sm text-fg-muted">{caption}</p>
      {naming ? <p className="mt-3 text-sm text-fg-muted">{naming}</p> : null}
    </div>
  );
}

/**
 * The same opening for a signed-out screen that is about a task rather than a
 * workspace (reset a password, accept an invitation): the product mark, the
 * task as the heading, and a quiet caption.
 */
export function AuthHeader({ title, caption = 'VendorConnect' }) {
  return (
    <div className="mb-8 flex flex-col items-center text-center">
      <Mark />
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <p className="mt-1 text-sm text-fg-muted">{caption}</p>
    </div>
  );
}
