'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, LogOut } from 'lucide-react';
import { WorkspaceSessionProvider, useWorkspaceSession, STAGE } from '@/lib/workspace-session';
import { navFor, isActive } from '@/lib/workspaceNav';

// The tenant back office's chrome. It shares the design system and the
// primitives with the platform console, and nothing else: different plane,
// different nav, different session.

const signOut = (router) => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('clerk_user_id');
    localStorage.removeItem('sap_vendor_profile_data');
  }
  router.push('/sign-in');
};

function Chrome({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, workspace, permissions, plane } = useWorkspaceSession();
  const items = navFor(permissions, plane);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-base font-sans text-text-primary">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-3">
          {workspace?.branding?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a tenant's own URL, not a build-time asset
            <img src={workspace.branding.logo} alt="" className="h-5 w-auto" />
          ) : (
            <span className="mono text-[13px] font-semibold tracking-tight">VendorConnect</span>
          )}
          <span className="border border-border-em px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
            {workspace?.companyName || 'Workspace'}
          </span>
        </div>

        <div className="flex items-center gap-4">
          <Link href="/" className="text-[11px] text-text-tertiary hover:text-text-primary">
            Portal
          </Link>
          <div className="text-right leading-tight">
            <p className="text-[12px] text-text-primary">{user?.name || user?.email}</p>
            <p className="mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">{user?.role}</p>
          </div>
          <button type="button" onClick={() => signOut(router)} className="btn btn-o h-8 px-2.5" title="Sign out">
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

        <main id="workspace-content" className="custom-scrollbar flex-1 overflow-y-auto px-6 py-5">
          {children}
        </main>
      </div>
    </div>
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
      <div className="flex min-h-screen items-center justify-center bg-base px-4">
        <div className="card max-w-[440px] p-8">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Not your workspace</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">
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
      <Loader2 className="size-5 animate-spin text-text-tertiary" />
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
