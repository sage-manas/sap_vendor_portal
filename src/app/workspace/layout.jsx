'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2, CreditCard, FileText, History, LayoutDashboard, Loader2, LogOut, Receipt, Settings, ShoppingBag, Store, Truck, Users,
} from 'lucide-react';
import AppShell from '@/components/shell/AppShell';
import SapStatus from '@/components/shell/SapStatus';
import ThemeToggle from '@/components/shell/ThemeToggle';
import UserMenu from '@/components/shell/UserMenu';
import { roleLabel } from '@/components/shell/roleLabel';
import { WorkspaceSessionProvider, useWorkspaceSession, STAGE } from '@/lib/workspace-session';
import { navFor, isActive } from '@/lib/workspaceNav';
import { forgetWhoami } from '@/lib/whoami';

// The tenant back office's chrome. It shares the design system and the
// primitives with the platform console, and nothing else: different plane,
// different nav, different session.

const signOut = (router) => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('clerk_user_id');
    localStorage.removeItem('sap_vendor_profile_data');
    forgetWhoami();
  }
  router.push('/sign-in');
};

// Presentation only: the nav registry (workspaceNav.js) decides what shows.
const ICONS = {
  '/workspace': LayoutDashboard,
  '/workspace/suppliers': Building2,
  '/workspace/rfqs': FileText,
  '/workspace/purchase-orders': ShoppingBag,
  '/workspace/shipments': Truck,
  '/workspace/invoices': Receipt,
  '/workspace/payments': CreditCard,
  '/workspace/audit': History,
  '/workspace/users': Users,
  '/workspace/settings': Settings,
};

function Chrome({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, workspace, permissions, plane } = useWorkspaceSession();
  const items = navFor(permissions, plane).map((item) => ({
    key: item.href,
    href: item.href,
    label: item.label,
    icon: ICONS[item.href],
    active: isActive(item, pathname),
    group: item.group,
  }));
  const name = workspace?.companyName || 'Workspace';

  return (
    <AppShell
      surface="workspace"
      mainId="workspace-content"
      identity={{ logo: workspace?.branding?.logo || null, mark: name.charAt(0).toUpperCase(), title: name, caption: 'Workspace' }}
      nav={items.filter((item) => item.group !== 'admin')}
      footerNav={items.filter((item) => item.group === 'admin')}
      topbar={{
        end: (
          <>
            <SapStatus />
            <ThemeToggle />
            <UserMenu
              name={user?.name || user?.email}
              caption={[roleLabel(user?.role), user?.name ? user?.email : null].filter(Boolean).join(' · ')}
              items={[
                { label: 'Supplier portal', icon: Store, href: '/' },
                'separator',
                { label: 'Sign out', icon: LogOut, onClick: () => signOut(router) },
              ]}
            />
          </>
        ),
      }}
    >
      <div className="px-4 py-5 md:px-6 md:py-6">{children}</div>
    </AppShell>
  );
}

/**
 * Renders the back office to tenant staff, and an explanation to anyone else.
 * This is a UX gate, not the security boundary: every endpoint behind it
 * declares its own permission, and the nav is filtered by the same list the
 * API enforces.
 */
function Gate({ children }) {
  const { stage } = useWorkspaceSession();
  const router = useRouter();

  React.useEffect(() => {
    if (stage === STAGE.SIGNED_OUT) router.replace('/sign-in');
  }, [stage, router]);

  if (stage === STAGE.WORKSPACE) return <Chrome>{children}</Chrome>;

  if (stage === STAGE.WRONG_PLANE) {
    return (
      <div className="auth-page-wrapper flex min-h-screen items-center justify-center px-4">
        <div className="card max-w-[440px] p-8">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Not your workspace</h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            The back office belongs to the buying organisation. Your supplier portal has everything
            your account can act on.
          </p>
          <Link href="/" className="btn btn-v mt-6 h-10 justify-center">Back to the portal</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-base">
      <Loader2 className="size-5 animate-spin text-fg-subtle" />
    </div>
  );
}

export default function WorkspaceLayout({ children }) {
  return (
    <WorkspaceSessionProvider>
      <Gate>{children}</Gate>
    </WorkspaceSessionProvider>
  );
}
