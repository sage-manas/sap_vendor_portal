'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Menu, PanelLeft, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

// The one application shell for all three surfaces — supplier portal, tenant
// workspace and platform console. Each layout supplies its own navigation
// (already filtered by its own permission registry), identity and top-bar
// items; the shell owns layout, collapse, the phone sheet and keyboard access.
//
// nav / footerNav: [{ key, label, icon, href? | onClick?, active, count?, countLabel? }]

const COLLAPSE_KEY = 'vc-sidebar-collapsed';

const SURFACE = {
  supplier: { label: 'Supplier portal', header: '' },
  workspace: { label: 'Workspace', header: '' },
  // Operators act across every tenant; an inverted header makes the console
  // impossible to mistake for a tenant workspace.
  platform: { label: 'Platform console', header: 'bg-fg text-canvas [&_.identity-caption]:text-canvas/70' },
};

// The collapsed state lives in localStorage and is read through
// useSyncExternalStore: the server snapshot is "expanded", so hydration
// matches, and every shell on the page (and other tabs) stays in step.
const COLLAPSE_EVENT = 'vc-sidebar-collapsed-change';
const readCollapsed = () => {
  try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
};
const subscribeCollapsed = (onChange) => {
  window.addEventListener('storage', onChange);
  window.addEventListener(COLLAPSE_EVENT, onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener(COLLAPSE_EVENT, onChange);
  };
};
const writeCollapsed = (value) => {
  try { localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0'); } catch { /* private mode: not remembered */ }
  window.dispatchEvent(new Event(COLLAPSE_EVENT));
};

function NavItem({ item, collapsed, onNavigate }) {
  const Icon = item.icon;
  const className = `group relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors cursor-pointer ${
    item.active ? 'bg-subtle font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
  } ${collapsed ? 'justify-center px-0' : ''}`;
  const content = (
    <>
      {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />}
      {!collapsed && <span className="flex-1 truncate text-left">{item.label}</span>}
      {item.count > 0 && (collapsed ? (
        <span className="absolute right-1.5 top-1 size-1.5 rounded-full bg-fg" aria-hidden="true" />
      ) : (
        <span aria-hidden="true" className="mono rounded-full bg-subtle px-1.5 text-xs leading-5 text-fg-muted group-hover:bg-surface">
          {item.count}
        </span>
      ))}
      {item.count > 0 && <span className="sr-only">, {item.countLabel || `${item.count} pending`}</span>}
    </>
  );
  const common = {
    className,
    'aria-current': item.active ? 'page' : undefined,
    title: collapsed ? item.label : undefined,
    onClick: () => { item.onClick?.(); onNavigate?.(); },
  };
  return item.href ? (
    <Link href={item.href} {...common}>{content}</Link>
  ) : (
    <button type="button" {...common}>{content}</button>
  );
}

function SidebarBody({ surface, identity, nav, footerNav, note, collapsed, onNavigate }) {
  const s = SURFACE[surface];
  return (
    <>
      <div className={`flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border px-3 ${s.header}`}>
        <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md bg-accent-solid text-sm font-semibold text-accent-fg">
          {identity.logo
            // eslint-disable-next-line @next/next/no-img-element -- a tenant's own logo URL, chosen at runtime
            ? <img src={identity.logo} alt="" className="size-full bg-surface object-contain" />
            : identity.mark}
        </span>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold" title={identity.title}>{identity.title}</p>
            <p className="identity-caption truncate text-xs text-fg-subtle">{identity.caption || s.label}</p>
          </div>
        )}
      </div>
      <nav aria-label={`${s.label} navigation`} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {nav.map((item) => <NavItem key={item.key} item={item} collapsed={collapsed} onNavigate={onNavigate} />)}
        {note && !collapsed && <div className="mx-1 mt-3 rounded-md bg-subtle p-2.5 text-xs text-fg-muted">{note}</div>}
        {footerNav?.length > 0 && (
          <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-2">
            {footerNav.map((item) => <NavItem key={item.key} item={item} collapsed={collapsed} onNavigate={onNavigate} />)}
          </div>
        )}
      </nav>
    </>
  );
}

export default function AppShell({ surface, identity, nav, footerNav, note, topbar, mainId = 'main-content', children }) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef(null);
  const menuButtonRef = useRef(null);

  const toggleCollapsed = useCallback(() => writeCollapsed(!readCollapsed()), []);

  // Ctrl/⌘ + B toggles the sidebar — except while typing.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  // Phone sheet: Escape closes, focus moves in and comes back.
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const opener = menuButtonRef.current;
    sheetRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setSheetOpen(false); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      opener?.focus();
    };
  }, [sheetOpen]);

  const bodyProps = { surface, identity, nav, footerNav, note };

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-fg">
      <aside
        className={`hidden shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 ease-out md:flex ${collapsed ? 'w-14' : 'w-60'}`}
      >
        <SidebarBody {...bodyProps} collapsed={collapsed} />
      </aside>

      {sheetOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-[var(--scrim)] animate-fade-in" onClick={() => setSheetOpen(false)} aria-hidden="true" />
          <aside
            ref={sheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-modal outline-none animate-slideIn"
          >
            <Button variant="ghost" size="icon" onClick={() => setSheetOpen(false)} aria-label="Close navigation" className="absolute right-2 top-2.5 z-10">
              <X strokeWidth={1.5} />
            </Button>
            <SidebarBody {...bodyProps} collapsed={false} onNavigate={() => setSheetOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-surface px-3 md:px-4">
          <Button ref={menuButtonRef} variant="ghost" size="icon" className="md:hidden" onClick={() => setSheetOpen(true)} aria-label="Open navigation">
            <Menu strokeWidth={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`}
          >
            <PanelLeft strokeWidth={1.5} />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">{topbar?.start}</div>
          <div className="flex shrink-0 items-center gap-1">{topbar?.end}</div>
        </header>
        <main id={mainId} className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
