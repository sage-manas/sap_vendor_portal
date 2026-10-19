'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Menu as MenuIcon, X } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { Button } from '@/components/ui/button';

// The one application shell for all three surfaces — supplier portal, tenant
// workspace and platform console. Each layout supplies its own navigation
// (already filtered by its own permission registry), identity and top-bar
// items; the shell owns layout, the narrow-screen sheet and keyboard access.
//
// Redesign v2: a top bar with the navigation as a floating pill (the Ledger
// sidebar is gone, and with it Ctrl+B). The first INLINE_LG items sit in the
// pill from 1024px, INLINE_XL from 1800px; the rest, and footerNav, are under
// "More". Below 1024px the whole list opens as a sheet.
//
// nav / footerNav: [{ key, label, icon, href? | onClick?, active, count?, countLabel? }]

// Past this, a dense operations screen stops being easier to read and starts
// being a row of very wide, very empty cards. The cap sits on the shell itself
// rather than on the header and the main area separately, so both measure from
// the same left edge — and main's scrollbar, which would otherwise shift its
// content a few pixels out of line with the header, sits inside the cap.
const MAX_W = 'mx-auto w-full max-w-[1600px]';

const INLINE_LG = 4;
const INLINE_XL = 6;

const SURFACE = {
  supplier: { label: 'Supplier portal', header: '' },
  workspace: { label: 'Workspace', header: '' },
  // Operators act across every tenant; an inverted header makes the console
  // impossible to mistake for a tenant workspace.
  platform: { label: 'Platform console', header: 'bg-fg text-canvas [&_.identity-caption]:text-canvas/70' },
};

const sr = (item) => item.count > 0 && <span className="sr-only">, {item.countLabel || `${item.count} pending`}</span>;

function CountBadge({ item, className = '' }) {
  if (!(item.count > 0)) return null;
  return <span aria-hidden="true" className={`mono rounded-pill px-1.5 text-xs leading-5 ${className}`}>{item.count}</span>;
}

/* An item in the top-bar pill. */
function PillItem({ item, display = 'inline-flex' }) {
  const cls = `${display} h-9 shrink-0 items-center gap-1.5 rounded-pill px-3.5 2xl:px-4 text-sm whitespace-nowrap transition-colors cursor-pointer ${
    item.active ? 'bg-subtle font-medium text-fg dark:bg-border-strong' : 'text-fg-muted hover:text-fg'
  }`;
  const content = (
    <>
      {item.label}
      <CountBadge item={item} className={item.active ? 'bg-surface text-fg' : 'bg-subtle text-fg-muted'} />
      {sr(item)}
    </>
  );
  const common = { className: cls, 'aria-current': item.active ? 'page' : undefined, onClick: () => item.onClick?.() };
  return item.href ? <Link href={item.href} {...common}>{content}</Link> : <button type="button" {...common}>{content}</button>;
}

/* "More": everything the pill has no room for. Items shown inline at xl are
   hidden from the menu there, so nothing appears twice. */
function MoreMenu({ items }) {
  if (!items.length) return null;
  const allXl = items.every((x) => x.inlineXl);
  const active = items.find((x) => x.item.active);
  const activeXl = active?.inlineXl;
  return (
    <Menu.Root>
      <Menu.Trigger
        className={`inline-flex h-9 shrink-0 items-center gap-1 rounded-pill px-3.5 2xl:px-4 text-sm cursor-pointer data-[popup-open]:bg-subtle ${
          active ? 'bg-subtle font-medium text-fg dark:bg-border-strong' : 'text-fg-muted hover:text-fg'
        } ${activeXl ? 'min-[1800px]:bg-transparent min-[1800px]:font-normal min-[1800px]:text-fg-muted dark:min-[1800px]:bg-transparent' : ''} ${allXl ? 'min-[1800px]:hidden' : ''}`}
      >
        {active ? <span className={activeXl ? 'min-[1800px]:hidden' : ''}>{active.item.label}</span> : null}
        <span className={active ? (activeXl ? 'hidden min-[1800px]:inline' : 'hidden') : ''}>More</span>
        <ChevronDown className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="center" sideOffset={8} className="z-50">
          <Menu.Popup className="min-w-52 rounded-xl border border-border bg-surface p-1.5 text-sm shadow-popover outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150">
            {items.map(({ item, inlineXl, separatorBefore }) => {
              const Icon = item.icon;
              return (
                <div key={item.key} className={inlineXl ? 'min-[1800px]:hidden' : ''}>
                  {separatorBefore && <div role="separator" className="my-1 h-px bg-border" />}
                  <Menu.Item
                    onClick={() => item.onClick?.()}
                    render={item.href ? <Link href={item.href} /> : undefined}
                    aria-current={item.active ? 'page' : undefined}
                    className={`flex h-9 cursor-pointer items-center gap-2.5 rounded-pill px-3 outline-none select-none data-[highlighted]:bg-subtle ${item.active ? 'font-medium text-fg' : 'text-fg-muted'}`}
                  >
                    {Icon && <Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />}
                    <span className="flex-1">{item.label}</span>
                    <CountBadge item={item} className="bg-subtle text-fg-muted" />
                    {sr(item)}
                  </Menu.Item>
                </div>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Identity({ surface, identity }) {
  const s = SURFACE[surface];
  return (
    <div className={`flex min-w-0 items-center gap-2.5 rounded-pill py-1 pl-1 pr-3 ${s.header}`}>
      <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-accent-solid text-sm font-semibold text-accent-fg">
        {identity.logo
          // eslint-disable-next-line @next/next/no-img-element -- a tenant's own logo URL, chosen at runtime
          ? <img src={identity.logo} alt="" className="size-full bg-surface object-contain" />
          : identity.mark}
      </span>
      <div className="hidden min-w-0 leading-tight sm:block">
        <p className="truncate text-sm font-semibold" title={identity.title}>{identity.title}</p>
        <p className="identity-caption truncate text-xs text-fg-subtle">{identity.caption || s.label}</p>
      </div>
    </div>
  );
}

function NavItem({ item, collapsed, onNavigate }) {
  const Icon = item.icon;
  const className = `group relative flex h-10 w-full items-center gap-2.5 rounded-pill px-3.5 text-sm transition-colors cursor-pointer ${
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

function SidebarBody({ surface, identity, nav, footerNav, note, collapsed, onNavigate, headerAction }) {
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
        {headerAction && <div className="ml-auto shrink-0">{headerAction}</div>}
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

export default function AppShell({ surface, identity, nav, footerNav = [], note, topbar, mainId = 'main-content', children }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetRef = useRef(null);
  const menuButtonRef = useRef(null);
  const s = SURFACE[surface];

  // Sheet: Escape closes, Tab stays inside, focus moves in and comes back,
  // and widening past the breakpoint closes it (otherwise the hidden sheet
  // would keep the page's scroll locked).
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const opener = menuButtonRef.current;
    const sheet = sheetRef.current;
    sheet?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') { setSheetOpen(false); return; }
      if (e.key !== 'Tab' || !sheet) return;
      const focusables = sheet.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    const wide = window.matchMedia?.('(min-width: 1024px)');
    const onWide = (e) => { if (e.matches) setSheetOpen(false); };

    window.addEventListener('keydown', onKey);
    wide?.addEventListener('change', onWide);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      wide?.removeEventListener('change', onWide);
      document.body.style.overflow = '';
      opener?.focus();
    };
  }, [sheetOpen]);

  const inline = nav.slice(0, INLINE_XL);
  const overflow = [
    ...nav.slice(INLINE_LG).map((item, i) => ({ item, inlineXl: INLINE_LG + i < INLINE_XL })),
    ...footerNav.map((item, i) => ({ item, separatorBefore: i === 0 && nav.length > INLINE_LG })),
  ];

  return (
    <div className={`${MAX_W} flex h-dvh flex-col overflow-hidden bg-canvas text-fg`}>
      {sheetOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[var(--scrim)] animate-fade-in" onClick={() => setSheetOpen(false)} aria-hidden="true" />
          <aside
            ref={sheetRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-2 left-2 flex w-72 max-w-[85vw] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-modal outline-none animate-slideIn"
          >
            <SidebarBody
              surface={surface}
              identity={identity}
              nav={nav}
              footerNav={footerNav}
              note={note}
              collapsed={false}
              onNavigate={() => setSheetOpen(false)}
              headerAction={(
                // Inherits the header's colour: on the platform console's
                // inverted header a muted ghost icon would all but disappear.
                <Button variant="ghost" size="icon" onClick={() => setSheetOpen(false)} aria-label="Close navigation" className="-mr-1 [color:inherit]! opacity-75 hover:opacity-100 hover:bg-transparent!">
                  <X strokeWidth={1.5} />
                </Button>
              )}
            />
          </aside>
        </div>
      )}

      <header className="flex h-16 min-w-0 shrink-0 items-center gap-2 px-4 md:gap-3 md:px-6">
        <Button ref={menuButtonRef} variant="ghost" size="icon" className="lg:hidden" onClick={() => setSheetOpen(true)} aria-label="Open navigation">
          <MenuIcon strokeWidth={1.5} />
        </Button>
        <div className="flex min-w-0 shrink items-center lg:max-w-56 2xl:max-w-64">
          <Identity surface={surface} identity={identity} />
        </div>
        <nav aria-label={`${s.label} navigation`} className="hidden min-w-0 flex-1 justify-center lg:flex">
          <div className="flex items-center gap-0.5 rounded-pill border border-border bg-surface p-1 shadow-card">
            {inline.map((item, i) => (
              <PillItem key={item.key} item={item} display={i >= INLINE_LG ? 'hidden min-[1800px]:inline-flex' : 'inline-flex'} />
            ))}
            <MoreMenu items={overflow} />
          </div>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 lg:ml-0">
          {topbar?.start}
          {topbar?.end}
        </div>
      </header>
      {note && (
        <div className="mx-4 mb-2 rounded-pill bg-subtle px-4 py-2 text-sm text-fg-muted md:mx-6">{note}</div>
      )}
      <main id={mainId} className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
