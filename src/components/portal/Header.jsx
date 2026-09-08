'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Search, Sun, Moon, Bell, CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';

import { usePortal } from '@/lib/portal-context';
import { useTheme } from '@/lib/theme-context';

const NOTIF_ICONS = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
  info: Info
};

export default function Header() {
  const { sidebarCollapsed, setSidebarCollapsed, notifications, markNotificationsRead, clearNotifications } = usePortal();
  const { theme, toggleTheme, mounted } = useTheme();
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  const unreadCount = notifications.filter(n => !n.read).length;

  useEffect(() => {
    if (!notifOpen) return;
    const onClickOutside = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [notifOpen]);

  const toggleNotifications = () => {
    setNotifOpen(prev => !prev);
    if (!notifOpen) markNotificationsRead();
  };

  const openPalette = () => {
    window.dispatchEvent(new CustomEvent('open-command-palette'));
  };

  return (
    <header className="h-11 bg-surface text-text-primary border-b border-border px-4 flex items-center justify-between shrink-0 select-none z-10">
      {/* BRANDING SECTION */}
      <div className="flex items-center gap-3">

        <div className="flex items-center gap-2">
          <div className="size-7 rounded flex items-center justify-center text-white font-extrabold text-sm shrink-0" style={{ backgroundColor: 'rgb(var(--color-emerald-default-rgb))', color: '#FFFFFF' }}>
            V
          </div>
          <div>
            <h1 className="font-bold text-[13px] leading-tight tracking-wide text-text-primary">VendorConnect Portal</h1>
            <p className="text-[9px] text-text-tertiary font-mono tracking-wider uppercase">
              ENTERPRISE INTEGRATED &bull; GST COMPLIANT &bull; INDIA
            </p>
          </div>
        </div>
      </div>

      {/* METADATA CAPSULES */}
      <div className="flex items-center gap-1.5">
        <span className="chip bg-surface2 text-text-secondary hidden lg:inline-flex">
          Indian Enterprise
        </span>
        <span className="chip bg-surface2 text-text-secondary flex items-center gap-1">
          <span className="status-dot status-dot-active"></span>
          CONNECTED
        </span>
        <span className="chip bg-surface2 text-text-secondary hidden lg:inline-flex">
          GST + TDS + MSME
        </span>

        <div className="w-px h-5 bg-border mx-1" />

        {/* Command palette trigger */}
        <button
          onClick={openPalette}
          title="Search & commands"
          className="group flex items-center gap-2 h-7 pl-2 pr-1.5 rounded-md border border-border-em bg-surface2/60 text-text-tertiary hover:text-text-primary hover:border-border-em hover:bg-surface2 transition-colors duration-150 cursor-pointer"
        >
          <Search className="size-3.5" />
          <span className="text-[11px] font-medium hidden sm:inline">Search</span>
          <kbd className="text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded bg-surface border border-border text-text-tertiary group-hover:text-text-secondary">
            Ctrl K
          </kbd>
        </button>

        {/* Notifications bell */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={toggleNotifications}
            title="Notifications"
            aria-label="Notifications"
            className="relative flex items-center justify-center size-7 rounded-md border border-border-em text-text-tertiary hover:text-text-primary hover:bg-surface2 transition-colors duration-150 cursor-pointer"
          >
            <Bell className="size-3.5" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-4 min-w-4 px-1 bg-red-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center border-2 border-surface tabular-nums">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {notifOpen && (
            <div className="absolute right-0 top-9 w-80 max-h-96 overflow-y-auto card z-20 animate-fade-in">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface2 sticky top-0">
                <span className="text-[11px] font-bold text-text-primary uppercase tracking-wider">Notifications</span>
                {notifications.length > 0 && (
                  <button
                    onClick={clearNotifications}
                    className="text-[10px] font-semibold text-text-tertiary hover:text-text-primary cursor-pointer"
                  >
                    Clear all
                  </button>
                )}
              </div>
              {notifications.length === 0 ? (
                <p className="text-[11px] text-text-tertiary text-center py-6 px-3">No notifications yet.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {notifications.map((n) => {
                    const Icon = NOTIF_ICONS[n.type] || Info;
                    return (
                      <li key={n.id} className="flex items-start gap-2.5 px-3 py-2.5">
                        <Icon className={`size-3.5 shrink-0 mt-0.5 ${
                          n.type === 'success' ? 'text-[#059669]' :
                          n.type === 'error' ? 'text-[#e11d48]' :
                          n.type === 'warning' ? 'text-amber-500' :
                          'text-text-tertiary'
                        }`} />
                        <div className="min-w-0">
                          <p className="text-[11px] text-text-secondary leading-relaxed">{n.message}</p>
                          <span className="text-[9px] text-text-tertiary font-mono">
                            {new Date(n.timestamp).toLocaleTimeString('en-IN')}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle color theme"
          className="flex items-center justify-center size-7 rounded-md border border-border-em text-text-tertiary hover:text-text-primary hover:bg-surface2 transition-colors duration-150 cursor-pointer"
        >
          {mounted && theme === 'dark'
            ? <Sun className="size-3.5" />
            : <Moon className="size-3.5" />}
        </button>
      </div>
    </header>
  );
}
