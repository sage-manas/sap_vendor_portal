'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { Database, LogOut, Search } from 'lucide-react';
import CommandPalette from '../ui/CommandPalette';
import TenantBranding from './TenantBranding';
import { BACK_OFFICE, OVERVIEW, SUPPLIER_MODULES } from './supplierModules';
import AppShell from '../shell/AppShell';
import SapStatus from '../shell/SapStatus';
import NotificationsMenu from '../shell/NotificationsMenu';
import ThemeToggle from '../shell/ThemeToggle';
import UserMenu from '../shell/UserMenu';
import { usePortal } from '@/lib/portal-context';
import { useWhoami } from '@/lib/whoami';
import { useWorkspaceRealm } from '@/lib/workspace-realm';
import { modulesFor, isOnboarding } from '@/lib/onboarding';
import { hasOwnChrome, isAuthPath } from '@/lib/planes';

const isDevEnv = process.env.NODE_ENV !== 'production';

export default function PortalLayout({ children }) {
  const pathname = usePathname();
  const { activeTab, setActiveTab, state, handleResetDatabase, logout } = usePortal();
  const { isTenantStaff } = useWhoami();
  const { companyName: buyerName, branding } = useWorkspaceRealm();

  const isAuthPage = isAuthPath(pathname);

  // The platform console and the tenant workspace are different planes, each
  // with its own shell, session and navigation. The supplier chrome has no
  // meaning in either, so this layout steps out of the way entirely.
  const hasSeparateChrome = hasOwnChrome(pathname);

  // Client-only values (profile, badge counts) are held back until after
  // hydration so the server's HTML still matches.
  const mounted = React.useSyncExternalStore(() => () => {}, () => true, () => false);

  React.useEffect(() => {
    if (hasSeparateChrome) return undefined;
    if (isAuthPage) {
      document.body.classList.add('auth-mode');
    } else {
      document.body.classList.remove('auth-mode');
    }
    return () => {
      document.body.classList.remove('auth-mode');
    };
  }, [isAuthPage, hasSeparateChrome]);

  if (hasSeparateChrome) {
    return children;
  }

  if (isAuthPage) {
    return (
      <div id="main-content" className="auth-page-wrapper min-h-screen w-full bg-canvas flex items-center justify-center py-8 px-4">
        <TenantBranding />
        {children}
      </div>
    );
  }

  const profile = state.profile || {};
  const onboarding = mounted && !isTenantStaff && isOnboarding(profile);
  const modules = modulesFor(SUPPLIER_MODULES, { isSupplier: !isTenantStaff, profile });

  const openOrders = mounted ? (state.pos || []).filter((p) => p.status === 'Open').length : 0;
  const openRfqs = mounted ? (state.rfqs || []).filter((r) => r.status === 'Bidding Open').length : 0;
  const counts = {
    pos: { count: openOrders, countLabel: `${openOrders} ${openOrders === 1 ? 'order needs' : 'orders need'} acknowledgement` },
    rfqs: { count: openRfqs, countLabel: `${openRfqs} ${openRfqs === 1 ? 'RFQ is' : 'RFQs are'} open for quotation` },
  };

  const item = ({ id, name, icon }) => ({
    key: id, label: name, icon, active: activeTab === id, onClick: () => setActiveTab(id), ...counts[id],
  });

  const nav = [
    item(OVERVIEW),
    // The back office belongs to the buying organisation's own staff. Which
    // accounts those are is the server's answer (ADR-0027).
    ...(isTenantStaff ? [item(BACK_OFFICE)] : []),
    ...modules.filter((m) => m.id !== 'registration').map(item),
  ];
  const footerNav = modules.filter((m) => m.id === 'registration').map(item);

  const companyName = (mounted && profile.companyName) || 'Guest supplier';
  const vendorCode = mounted && profile.sapVendorCode;

  const openPalette = () => window.dispatchEvent(new CustomEvent('open-command-palette'));

  return (
    <>
      <TenantBranding />
      <CommandPalette />
      <AppShell
        surface="supplier"
        identity={{
          logo: branding?.logo || null,
          mark: (buyerName || 'VendorConnect').charAt(0).toUpperCase(),
          title: buyerName || 'VendorConnect',
          caption: 'Supplier portal',
        }}
        nav={nav}
        footerNav={footerNav}
        note={onboarding ? 'Complete and submit your registration to unlock RFQs, purchase orders, invoices and payments.' : null}
        topbar={{
          start: (
            <button
              type="button"
              onClick={openPalette}
              className="flex h-8 w-full max-w-72 items-center gap-2 rounded-md border border-border bg-canvas px-2.5 text-sm text-fg-subtle hover:border-border-strong hover:text-fg-muted cursor-pointer"
            >
              <Search className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span className="flex-1 truncate text-left">Search orders, invoices…</span>
              <kbd className="hidden rounded border border-border px-1 font-mono text-xs text-fg-muted sm:inline">Ctrl K</kbd>
            </button>
          ),
          end: (
            <>
              <SapStatus />
              <NotificationsMenu />
              <ThemeToggle />
              <UserMenu
                name={companyName}
                caption={vendorCode ? `Supplier code ${vendorCode}` : 'Supplier code pending'}
                items={[
                  ...(isDevEnv ? [{ label: 'Reset demo data (dev only)', icon: Database, onClick: handleResetDatabase }] : []),
                  'separator',
                  { label: 'Sign out', icon: LogOut, onClick: logout },
                ]}
              />
            </>
          ),
        }}
      >
        <div className="px-4 py-5 md:px-6 md:py-6">{children}</div>
      </AppShell>
    </>
  );
}
