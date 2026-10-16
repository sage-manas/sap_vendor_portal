'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Building2, History, LayoutDashboard, LogOut, Plug, RefreshCcw, ShieldCheck } from 'lucide-react';
import AppShell from '@/components/shell/AppShell';
import ThemeToggle from '@/components/shell/ThemeToggle';
import UserMenu from '@/components/shell/UserMenu';
import { roleLabel } from '@/components/shell/roleLabel';
import { PlatformSessionProvider, usePlatformSession } from '@/lib/platform-session';
import PlatformGate from '@/components/platform/PlatformGate';
import { navFor, isActive } from '@/lib/platformNav';

// The platform console's own chrome. It shares nothing with the supplier
// portal's shell but the design system: different plane, different nav,
// different session, different token.

// Presentation only: the nav registry (platformNav.js) decides what shows.
const ICONS = {
  '/platform': LayoutDashboard,
  '/platform/tenants': Building2,
  '/platform/sap': Plug,
  '/platform/reconciliation': RefreshCcw,
  '/platform/audit': History,
  '/platform/operators': ShieldCheck,
};

function Chrome({ children }) {
  const pathname = usePathname();
  const { operator, permissions, signOut } = usePlatformSession();
  const items = navFor(permissions).map((item) => ({
    key: item.href,
    href: item.href,
    label: item.label,
    icon: ICONS[item.href],
    active: isActive(item, pathname),
    group: item.group,
  }));

  return (
    <AppShell
      surface="platform"
      mainId="platform-content"
      identity={{ mark: 'V', title: 'VendorConnect', caption: 'Platform console' }}
      nav={items.filter((item) => item.group !== 'admin')}
      footerNav={items.filter((item) => item.group === 'admin')}
      topbar={{
        end: (
          <>
            <ThemeToggle />
            <UserMenu
              name={operator?.name || operator?.email}
              caption={[roleLabel(operator?.role), operator?.email].filter(Boolean).join(' · ')}
              items={[{ label: 'Sign out', icon: LogOut, onClick: signOut }]}
            />
          </>
        ),
      }}
    >
      <div className="px-4 py-5 md:px-6 md:py-6">{children}</div>
    </AppShell>
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
