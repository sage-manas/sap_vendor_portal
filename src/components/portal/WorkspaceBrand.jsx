'use client';

import React from 'react';
import { Building2 } from 'lucide-react';
import { brandMark } from '@/lib/branding';

/**
 * The mark at the top of a signed-out screen: whose workspace this is.
 *
 * A supplier arrives at their buyer's address, not at ours, so the buyer's name
 * is the heading and VendorConnect is the caption underneath. Before the realm
 * answers, `workspace` is null and this falls back to the product's own mark —
 * the same thing an unbranded tenant shows.
 */
export default function WorkspaceBrand({ workspace, caption }) {
  const { logo, name } = brandMark(workspace);

  return (
    <div className="flex flex-col items-center mb-8">
      {logo ? (
        // A tenant's logo is an arbitrary remote URL chosen at runtime, so it
        // cannot go through next/image's configured-domains optimiser.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logo}
          alt={`${name} logo`}
          className="h-12 max-w-[180px] object-contain mb-3"
        />
      ) : (
        <div
          className="size-12 rounded-none flex items-center justify-center text-white mb-3 shrink-0"
          style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }}
        >
          <Building2 className="size-6" />
        </div>
      )}
      <h2 className="text-xl font-bold text-text-primary tracking-wide text-center">{name}</h2>
      <p className="text-[10px] text-text-tertiary font-mono tracking-wider uppercase mt-1 text-center">
        {caption}
      </p>
    </div>
  );
}
