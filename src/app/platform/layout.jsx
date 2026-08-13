'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { PlatformSessionProvider, usePlatformSession } from '@/lib/platform-session';
import PlatformGate from '@/components/platform/PlatformGate';
import { navFor, isActive } from '@/lib/platformNav';

// The platform console's own chrome. It shares nothing with the supplier
// portal's shell but the design system: different plane, different nav,
// different session, different token.

function Chrome({ children }) {
  const pathname = usePathname();
  const { operator, permissions, signOut } = usePlatformSession();
  const items = navFor(permissions);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-base font-sans text-text-primary">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-3">
          <span className="mono text-[13px] font-semibold tracking-tight">VendorConnect</span>
          <span className="border border-border-em px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
            Platform
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-right leading-tight">
            <p className="text-[12px] text-text-primary">{operator?.name}</p>
            <p className="mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">{operator?.role}</p>
          </div>
          <button type="button" onClick={signOut} className="btn btn-o h-8 px-2.5" title="Sign out">
            <LogOut className="size-3.5" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-56 shrink-0 border-r border-border bg-surface p-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-link ${isActive(item, pathname) ? 'active' : ''}`}
              title={item.description}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <main id="platform-content" className="custom-scrollbar flex-1 overflow-y-auto px-6 py-5">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function PlatformLayout({ children }) {
  return (
    <PlatformSessionProvider>
      <PlatformGate>
        <Chrome>{children}</Chrome>
      </PlatformGate>
    </PlatformSessionProvider>
  );
}
