import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Search, FileText, ShoppingBag, Receipt, CreditCard, LayoutDashboard,
  UserCheck, Activity, BarChart3, Database, Sun, Moon, LogOut,
  CornerDownLeft, ArrowUp, ArrowDown, Hash
} from 'lucide-react';
import { usePortal } from '@/lib/portal-context';
import { useTheme } from '@/lib/theme-context';
import { useWhoami } from '@/lib/whoami';
import { modulesFor } from '@/lib/onboarding';

// Lightweight subsequence-aware substring match across a record's searchable text.
const matches = (haystack, needle) =>
  haystack.toLowerCase().includes(needle.toLowerCase());

export default function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const {
    setActiveTab, state, handleResetDatabase, logout,
    setSelectedPoId, setSelectedRfqId
  } = usePortal();
  const { theme, toggleTheme } = useTheme();

  // The back office is the buying organisation's, and the server is the one
  // that says who that is (ADR-0027) — the old check was an email suffix and a
  // role that no longer exists.
  const { isTenantStaff } = useWhoami();

  const isOpenRef = useRef(false);
  const open = useCallback(() => {
    setQuery('');
    setSelectedIndex(0);
    setIsOpen(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  // ── Navigation entries ─────────────────────────────────────────────────
  // Same split as Sidebar.jsx: the dashboard (and, for staff, the back
  // office) are always reachable; the transacting modules go through the
  // same onboarding/approval gate so the palette never offers a tab the
  // sidebar has hidden.
  const navItems = useMemo(() => {
    const allModules = [
      { id: 'registration', name: 'Vendor Registration', icon: UserCheck },
      { id: 'rfqs', name: 'RFQ Management', icon: FileText },
      { id: 'pos', name: 'Purchase Orders', icon: ShoppingBag },
      { id: 'invoices', name: 'Invoice Processing', icon: Receipt },
      { id: 'payments', name: 'Payment Tracking', icon: CreditCard },
      { id: 'performance', name: 'Performance', icon: Activity },
      { id: 'analytics', name: 'Reports & Analytics', icon: BarChart3 },
    ];
    const items = [
      { id: 'dashboard', name: 'Vendor Dashboard', icon: LayoutDashboard },
      ...modulesFor(allModules, { isSupplier: !isTenantStaff, profile: state.profile }),
    ];
    if (isTenantStaff) items.push({ id: 'workspace', name: 'Workspace Back Office', icon: Database });
    return items.map((n) => ({
      key: `nav-${n.id}`,
      group: 'Navigation',
      name: n.name,
      subtitle: 'Go to',
      icon: n.icon,
      search: n.name,
      perform: () => setActiveTab(n.id),
    }));
  }, [isTenantStaff, setActiveTab, state.profile]);

  // ── Action entries ─────────────────────────────────────────────────────
  const actionItems = useMemo(() => [
    {
      key: 'act-theme',
      group: 'Actions',
      name: theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode',
      subtitle: 'Appearance',
      icon: theme === 'dark' ? Sun : Moon,
      search: 'toggle theme dark light mode appearance',
      perform: () => toggleTheme(),
      keepOpen: true,
    },
    ...(process.env.NODE_ENV !== 'production' ? [{
      key: 'act-reset',
      group: 'Actions',
      name: 'Reset demo data',
      subtitle: 'Danger (dev only)',
      icon: Database,
      search: 'reset demo data database clear transactions',
      perform: () => handleResetDatabase(),
    }] : []),
    {
      key: 'act-logout',
      group: 'Actions',
      name: 'Log Out',
      subtitle: 'Session',
      icon: LogOut,
      search: 'log out sign out logout session',
      perform: () => logout(),
    },
  ], [theme, toggleTheme, handleResetDatabase, logout]);

  // ── Record entries (only when searching, capped per type) ───────────────
  const recordItems = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.trim();
    const out = [];

    (state?.pos || []).forEach((po) => {
      const search = `${po.id ?? ''} ${po.status ?? ''} ${po.vendorName ?? ''} po purchase order`;
      if (matches(search, q)) {
        out.push({
          key: `po-${po.id}`,
          group: 'Purchase Orders',
          name: String(po.id ?? 'PO'),
          subtitle: po.status ? `PO · ${po.status}` : 'Purchase Order',
          icon: ShoppingBag,
          perform: () => { setSelectedPoId(po.id); setActiveTab('pos'); },
        });
      }
    });

    (state?.rfqs || []).forEach((rfq) => {
      const search = `${rfq.id ?? ''} ${rfq.title ?? ''} ${rfq.status ?? ''} rfq quotation`;
      if (matches(search, q)) {
        out.push({
          key: `rfq-${rfq.id}`,
          group: 'RFQs',
          name: String(rfq.title || rfq.id || 'RFQ'),
          subtitle: rfq.id ? `RFQ · ${rfq.id}` : 'Request for Quotation',
          icon: FileText,
          perform: () => { setSelectedRfqId(rfq.id); setActiveTab('rfqs'); },
        });
      }
    });

    (state?.invoices || []).forEach((inv) => {
      const num = inv.invoiceNumber ?? inv.id;
      const search = `${num ?? ''} ${inv.status ?? ''} ${inv.poId ?? ''} invoice bill`;
      if (matches(search, q)) {
        out.push({
          key: `inv-${inv.id ?? num}`,
          group: 'Invoices',
          name: String(num ?? 'Invoice'),
          subtitle: inv.status ? `Invoice · ${inv.status}` : 'Invoice',
          icon: Receipt,
          perform: () => setActiveTab('invoices'),
        });
      }
    });

    (state?.payments || []).forEach((pmt) => {
      const ref = pmt.utrCode ?? pmt.id;
      const search = `${ref ?? ''} ${pmt.amount ?? ''} ${pmt.status ?? ''} payment utr`;
      if (matches(search, q)) {
        out.push({
          key: `pmt-${pmt.id ?? ref}`,
          group: 'Payments',
          name: String(ref ?? 'Payment'),
          subtitle: pmt.amount != null
            ? `Payment · ₹${Number(pmt.amount).toLocaleString('en-IN')}`
            : 'Payment',
          icon: CreditCard,
          perform: () => setActiveTab('payments'),
        });
      }
    });

    // Cap total records so the list stays scannable.
    return out.slice(0, 12);
  }, [query, state, setActiveTab, setSelectedPoId, setSelectedRfqId]);

  // ── Filter + flatten ───────────────────────────────────────────────────
  const flatItems = useMemo(() => {
    const q = query.trim();
    const filterByName = (arr) => (q === '' ? arr : arr.filter((it) => matches(it.search, q)));
    return [
      ...filterByName(navItems),
      ...filterByName(actionItems),
      ...recordItems,
    ];
  }, [query, navItems, actionItems, recordItems]);

  // Group the flat list for rendering while preserving flat indices for keyboard nav.
  const groups = useMemo(() => {
    const order = [];
    const byGroup = new Map();
    flatItems.forEach((item, index) => {
      if (!byGroup.has(item.group)) {
        byGroup.set(item.group, []);
        order.push(item.group);
      }
      byGroup.get(item.group).push({ ...item, index });
    });
    return order.map((name) => ({ name, items: byGroup.get(name) }));
  }, [flatItems]);

  // ── Open / close wiring ────────────────────────────────────────────────
  // Mirror open state into a ref so the global key listener can toggle without
  // re-subscribing on every state change.
  useEffect(() => { isOpenRef.current = isOpen; }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (isOpenRef.current) close(); else open();
      } else if (e.key === 'Escape') {
        close();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('open-command-palette', open);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('open-command-palette', open);
    };
  }, [open, close]);

  // Focus the input when the palette opens (external side effect only).
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [isOpen]);

  // Keep the highlighted row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const runItem = useCallback((item) => {
    if (!item) return;
    item.perform();
    if (!item.keepOpen) setIsOpen(false);
  }, []);

  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (flatItems.length ? (prev + 1) % flatItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (flatItems.length ? (prev - 1 + flatItems.length) % flatItems.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(flatItems[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 sm:pt-32">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
        onClick={close}
      />

      <div
        className="relative w-full max-w-xl mx-4 transform overflow-hidden rounded-xl bg-surface border border-border-em shadow-2xl animate-fade-in"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center border-b border-border px-4 py-3">
          <Search className="size-4.5 text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            className="w-full bg-transparent px-3 py-1 text-[14px] text-text-primary placeholder:text-text-tertiary focus:outline-none border-0"
            placeholder="Search POs, invoices, RFQs, or run a command…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="text-[10px] font-mono text-text-tertiary px-2 py-1 bg-surface2 rounded border border-border shrink-0">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[56vh] overflow-y-auto custom-scrollbar p-2">
          {flatItems.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Hash className="size-5 text-text-tertiary mx-auto mb-2" />
              <p className="text-[13px] text-text-secondary">No results for “{query}”</p>
              <p className="text-[11px] text-text-tertiary mt-1">Try a PO number, invoice, or “theme”.</p>
            </div>
          ) : (
            groups.map((grp) => (
              <div key={grp.name} className="mb-1.5 last:mb-0">
                <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.06em] text-text-tertiary">
                  {grp.name}
                </p>
                <div className="space-y-0.5">
                  {grp.items.map((item) => {
                    const Icon = item.icon;
                    const isSelected = item.index === selectedIndex;
                    return (
                      <button
                        key={item.key}
                        data-index={item.index}
                        onClick={() => runItem(item)}
                        onMouseMove={() => setSelectedIndex(item.index)}
                        className={`w-full flex items-center gap-3 px-3 py-2 text-left rounded-lg transition-colors duration-100 cursor-pointer ${
                          isSelected ? 'bg-surface2' : 'hover:bg-surface2/60'
                        }`}
                      >
                        <span className={`flex items-center justify-center size-7 rounded-md shrink-0 ${
                          isSelected ? 'bg-primary/15 text-primary' : 'bg-surface2 text-text-tertiary'
                        }`}>
                          <Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-text-primary truncate font-mono">
                            {item.name}
                          </span>
                          <span className="block text-[11px] text-text-tertiary truncate">
                            {item.subtitle}
                          </span>
                        </span>
                        {isSelected && (
                          <CornerDownLeft className="size-3.5 text-text-tertiary shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hints */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-[11px] text-text-tertiary">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><ArrowUp className="size-3" /><ArrowDown className="size-3" /> Navigate</span>
            <span className="flex items-center gap-1"><CornerDownLeft className="size-3" /> Select</span>
          </div>
          <span className="font-mono">{flatItems.length} result{flatItems.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  );
}
