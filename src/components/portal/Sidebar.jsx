'use client';

import React from 'react';
import {
  LayoutDashboard,
  UserCheck,
  FileText,
  ShoppingBag,
  Receipt,
  CreditCard,
  MessageSquare,
  Activity,
  BarChart3,
  Building2,
  Database,
  LogOut,
  Menu
} from 'lucide-react';
import { usePortal } from '@/lib/portal-context';
import { useWhoami } from '@/lib/whoami';

const isDevEnv = process.env.NODE_ENV !== 'production';

export default function Sidebar({ activeTab, setActiveTab, state, onReset }) {
  const { sidebarCollapsed, setSidebarCollapsed, logout } = usePortal();
  const { isTenantStaff } = useWhoami();
  const [mounted, setMounted] = React.useState(false);
  const [isHovered, setIsHovered] = React.useState(false);

  const isCollapsed = sidebarCollapsed && !isHovered;

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const navigationItems = [
    { id: 'dashboard', name: 'Vendor Dashboard', icon: LayoutDashboard }
  ];

  // The back office belongs to the buying organisation's own staff. Which
  // accounts those are is the server's answer, not an email suffix's (ADR-0027).
  if (isTenantStaff) {
    navigationItems.push({ id: 'workspace', name: 'Workspace Back Office', icon: Database });
  }

  const moduleItems = [
    { id: 'registration', name: 'Vendor Registration', icon: UserCheck },
    { id: 'rfqs', name: 'RFQ Management', icon: FileText },
    { id: 'pos', name: 'Purchase Orders', icon: ShoppingBag },
    { id: 'invoices', name: 'Invoice Processing', icon: Receipt },
    { id: 'payments', name: 'Payment Tracking', icon: CreditCard },
    { id: 'chats', name: 'Communications', icon: MessageSquare },
    { id: 'performance', name: 'Performance', icon: Activity },
    { id: 'analytics', name: 'Reports & Analytics', icon: BarChart3 }
  ];

  const renderLink = (item) => {
    const Icon = item.icon;
    const isActive = activeTab === item.id;
    return (
      <button
        key={item.id}
        onClick={() => setActiveTab(item.id)}
        title={isCollapsed ? item.name : undefined}
        className={`sidebar-link relative ${isActive ? 'active' : ''} ${
          isCollapsed ? 'justify-center px-0 py-2' : ''
        }`}
      >
        <Icon className="size-4 shrink-0" />
        {!isCollapsed && <span className="truncate">{item.name}</span>}

        {/* Dynamic Badge counts */}
        {mounted && item.id === 'pos' && (state.pos || []).filter(p => p.status === 'Open').length > 0 && (
          <span className={isCollapsed
            ? "absolute top-1 right-3.5 size-4 rounded-full text-white text-[8px] flex items-center justify-center font-bold"
            : "ml-auto size-4.5 rounded-full text-[9px] flex items-center justify-center font-bold"
          }
          style={isCollapsed
            ? { backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }
            : { backgroundColor: 'var(--color-emerald-dim)', color: 'rgb(var(--color-emerald-text-rgb))' }
          }>
            {(state.pos || []).filter(p => p.status === 'Open').length}
          </span>
        )}
        {mounted && item.id === 'rfqs' && (state.rfqs || []).filter(r => r.status === 'Bidding Open').length > 0 && (
          <span className={isCollapsed
            ? "absolute top-1 right-3.5 size-4 rounded-full text-white text-[8px] flex items-center justify-center font-bold"
            : "ml-auto size-4.5 rounded-full text-[9px] flex items-center justify-center font-bold"
          }
          style={isCollapsed
            ? { backgroundColor: 'rgb(var(--color-emerald-default-rgb))' }
            : { backgroundColor: 'var(--color-emerald-dim)', color: 'rgb(var(--color-emerald-text-rgb))' }
          }>
            {(state.rfqs || []).filter(r => r.status === 'Bidding Open').length}
          </span>
        )}
      </button>
    );
  };

  return (
    <aside 
      className={`bg-surface border-r border-border flex flex-col shrink-0 select-none h-full transition-all duration-200 ease-in-out relative z-40 ${
        isCollapsed ? 'w-[72px]' : 'w-[250px]'
      }`}
      onMouseEnter={() => sidebarCollapsed && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* NAVIGATION SECTION */}
      <div className={`pr-3 pt-6 ${isCollapsed ? 'flex flex-col items-center px-2' : ''}`}>
        {!isCollapsed ? (
          <p className="text-[11px] tracking-[0.06em] text-text-tertiary font-bold uppercase mb-2 px-4">
            Navigation
          </p>
        ) : (
          <div className="h-4 w-full border-b border-border mb-4" />
        )}
        <nav className="space-y-1 w-full">
          {navigationItems.map(renderLink)}
        </nav>
      </div>

      {/* MODULES SECTION */}
      <div className={`flex-1 pr-3 pt-6 overflow-y-auto custom-scrollbar ${isCollapsed ? 'flex flex-col items-center px-2' : ''}`}>
        {!isCollapsed ? (
          <p className="text-[11px] tracking-[0.06em] text-text-tertiary font-bold uppercase mb-2 px-4">
            Modules
          </p>
        ) : (
          <div className="h-4 w-full border-b border-border mb-4" />
        )}
        <nav className="space-y-1 w-full">
          {moduleItems.map(renderLink)}
        </nav>
      </div>

      {/* VENDOR PROFILE BOX */}
      <div className={`p-3 pb-6 border-t border-border bg-surface flex flex-col gap-2 ${isCollapsed ? 'items-center' : ''}`}>
        <div className="flex items-center gap-2 w-full justify-center">
          <div className="size-7 rounded-full bg-surface2 flex items-center justify-center text-text-primary border border-border shrink-0">
            <Building2 className="size-3.5" />
          </div>
          {!isCollapsed && (
            <div className="overflow-hidden min-w-0 flex-1">
              <h4 className="text-[11px] font-bold text-text-primary truncate" title={(mounted && state.profile.companyName) || 'Guest Vendor'}>
                {(mounted && state.profile.companyName) || 'Guest Vendor'}
              </h4>
              <p className="text-[10px] text-text-tertiary font-mono truncate">
                {(mounted && state.profile.sapVendorCode) || 'Pending Master'}
              </p>
            </div>
          )}
        </div>

        {/* Database Clean Reset Trigger — dev/local only, not a production control */}
        {isCollapsed ? (
          <div className="flex flex-col gap-1 mt-1">
            {isDevEnv && (
              <button
                onClick={onReset}
                className="text-text-tertiary hover:text-red-500 flex items-center justify-center p-1.5 rounded-md hover:bg-surface2 transition-colors duration-150 cursor-pointer"
                title="Reset ERP Database (dev only)"
              >
                <Database className="size-4" />
              </button>
            )}
            <button
              onClick={logout}
              className="text-text-tertiary hover:text-red-500 flex items-center justify-center p-1.5 rounded-md hover:bg-surface2 transition-colors duration-150 cursor-pointer"
              title="Log Out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1 mt-1">
            {isDevEnv && (
              <button
                onClick={onReset}
                className="text-left text-[11px] font-mono text-text-tertiary hover:text-red-500 hover:underline flex items-center gap-1.5 cursor-pointer transition-colors duration-150"
                title="Reset local state back to defaults (dev only)"
              >
                <Database className="size-3.5 shrink-0" />
                <span>Reset ERP Database</span>
              </button>
            )}
            <button
              onClick={logout}
              className="text-left text-[11px] font-mono text-text-tertiary hover:text-red-500 hover:underline flex items-center gap-1.5 cursor-pointer transition-colors duration-150"
              title="Log out of session"
            >
              <LogOut className="size-3.5 shrink-0" />
              <span>Log Out</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
