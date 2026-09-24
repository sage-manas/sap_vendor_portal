import React, { useState, useEffect } from 'react';
import { usePortal } from '@/lib/portal-context';
import SkeletonLoader from '@/components/shared/SkeletonLoader';
import ErrorBoundary from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import KPICard from '@/components/ui/KPICard';
import EmptyState from '@/components/ui/EmptyState';
import StatusBadge from '@/components/ui/StatusBadge';
import Drawer from '@/components/ui/Drawer';
import { poStatusVariant, invoiceStatusVariant } from '@/lib/statusColors';
import { downloadFromApi } from '@/lib/download';
import {
  FileText,
  ShoppingBag,
  Receipt,
  CreditCard,
  Activity,
  Download,
  AlertTriangle,
  Calendar,
  Sparkles,
  ChevronRight,
  FileCheck,
  RefreshCw,
  Wifi,
  WifiOff,
  FolderOpen,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';

// Amounts arrive as Decimal strings from the API (utils/money.js on the server).
const money = (value) => Number(value) || 0;

const inr = (value) =>
  `₹${money(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ₹8.4L / ₹1.2Cr for a headline figure; exact rupees below a lakh.
const inrCompact = (value) => {
  const n = money(value);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};

const shortDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Indian fiscal year runs April to March; Q1 is April–June.
const fiscalLabel = (date) => {
  const month = date.getMonth();
  const startYear = month >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  const quarter = Math.floor(((month + 9) % 12) / 3) + 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')} Q${quarter}`;
};

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const listIds = (rows, idOf) =>
  rows.slice(0, 3).map(idOf).join(', ') + (rows.length > 3 ? ` +${rows.length - 3}` : '');

export default function DashboardView({ state, setActiveTab }) {
  const portal = usePortal();

  // Local simulated production state flags
  const [isLoading, setIsLoading] = useState(true);
  const [apiError, setApiError] = useState(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [drawerContent, setDrawerContent] = useState(null); // { type: 'PO' | 'Invoice', data: any }
  const [selectedItemIds, setSelectedItemIds] = useState([]);

  // Auto-clear loading state after 1.2s to demonstrate skeleton states
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  // "Today" for the header, sampled once per mount so a render stays a
  // function of its inputs (the same rule ReportsAnalyticsView follows).
  const [today] = useState(() => new Date());

  // Everything below is derived from the supplier's own documents. Nothing on
  // this screen may be a constant standing in for data: a supplier reads these
  // figures as statements about their account.
  const profile = state.profile || {};
  const pos = state.pos || [];
  const invoices = state.invoices || [];
  const performance = state.performance || {};

  const openPOList = pos.filter(p => p.status === 'Open' || p.status === 'Acknowledged');
  const openPOCount = openPOList.length;
  const toAcknowledge = pos.filter(p => p.status === 'Open');
  const toShip = pos.filter(p => p.status === 'Acknowledged');

  const pendingInvoices = (state.grns || []).filter(g => !g.invoiceSubmitted);
  const pendingInvoicesCount = pendingInvoices.length;

  const unpaidInvoices = invoices.filter(inv => inv.status !== 'Cleared');
  const unpaidTotal = unpaidInvoices.reduce((sum, inv) => sum + money(inv.totalAmount), 0);
  const matchWarnings = invoices.filter(inv => inv.status === 'Match Warning');

  const openRfqs = (state.rfqs || []).filter(rfq =>
    rfq.status === 'Bidding Open' && !(rfq.bids || []).some(bid => bid.vendorId === profile.vendorId));

  const hasPerformance = performance.weightedScore != null;

  // Toggle API Error simulation
  const toggleConnection = () => {
    if (apiError) {
      setApiError(null);
    } else {
      setApiError({
        code: 'CONNECTION_TIMEOUT',
        message: 'We could not reach your buyer’s system. The connection timed out, so some data may be out of date.'
      });
    }
  };

  // Re-establish gateway mock trigger
  const handleRetryConnection = () => {
    setIsRetrying(true);
    setTimeout(() => {
      setIsRetrying(false);
      setApiError(null);
      setIsLoading(true);
      setTimeout(() => setIsLoading(false), 800);
    }, 1500);
  };

  // Pull latest POs action trigger. This used to spawn a fabricated inbound
  // order; purchase orders come from the buyer’s system, so it re-reads them instead.
  const handleFetchPOs = async () => {
    setIsLoading(true);
    try {
      await Promise.all([
        portal?.poHook?.refreshPOs?.(),
        portal?.poHook?.refreshSapPoStatus?.(),
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  // Helper function to render a custom illustrative empty state
  const renderEmptyState = (title, description, IconComp, actionText, onAction) => (
    <EmptyState
      icon={IconComp}
      title={title}
      description={description}
      className="min-h-[180px] animate-fade-in"
      action={actionText && onAction ? (
        <Button variant="ghost" size="sm" onClick={onAction}>
          <RefreshCw className="size-2.5" />
          <span>{actionText}</span>
        </Button>
      ) : undefined}
    />
  );

  // Helper for rendering skeleton loading shapes
  const renderCardSkeleton = () => (
    <div className="metric-panel !p-2.5 flex-row items-start justify-between animate-pulse">
      <div className="space-y-2 flex-1">
        <div className="skeleton h-2.5 rounded w-20"></div>
        <div className="skeleton h-5 rounded w-12"></div>
      </div>
      <div className="size-6 rounded-full skeleton shrink-0"></div>
    </div>
  );

  // Action items, each one a count of real documents that are waiting on the
  // supplier. No alert is shown for a condition the data does not establish.
  const alerts = [];
  if (matchWarnings.length > 0) {
    alerts.push({
      type: 'warning',
      title: `Invoice match warning (${listIds(matchWarnings, inv => inv.invoiceNumber || inv.id)})`,
      desc: 'The buyer’s three-way match flagged a difference between the order, the goods receipt and the invoice.',
      actionText: 'Review invoices',
      tab: 'invoices',
      icon: AlertTriangle,
      iconColor: 'text-amber-600 bg-amber-50 border-amber-200'
    });
  }
  if (toAcknowledge.length > 0) {
    alerts.push({
      type: 'acknowledge',
      title: `${plural(toAcknowledge.length, 'purchase order')} awaiting acknowledgement (${listIds(toAcknowledge, po => po.id)})`,
      desc: 'Confirm you accept the order so the buyer knows it is in hand.',
      actionText: 'Acknowledge',
      tab: 'pos',
      icon: Calendar,
      iconColor: 'text-red-700 bg-red-50 border-red-200'
    });
  }
  if (openRfqs.length > 0) {
    alerts.push({
      type: 'rfq',
      title: `${plural(openRfqs.length, 'RFQ')} open for your quotation (${listIds(openRfqs, rfq => rfq.id)})`,
      desc: `${openRfqs[0].description || 'Request for quotation'}${openRfqs.length > 1 ? ` and ${openRfqs.length - 1} more` : ''}.`,
      actionText: 'Submit Quotation',
      tab: 'rfqs',
      icon: Sparkles,
      iconColor: 'text-blue-700 bg-blue-50 border-blue-200'
    });
  }

  const toggleSelection = (id) => {
    setSelectedItemIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  // Selection is shared across the PO and Invoice lists, so each branch below only
  // acts on the ids that actually match its own dataset and skips the rest.
  const handleBulkAction = async (action) => {
    if (selectedItemIds.length === 0) return;

    let successCount = 0;
    let failCount = 0;

    if (action === 'Acknowledge') {
      for (const id of selectedItemIds) {
        const po = (state.pos || []).find(p => p.id === id);
        if (!po) {
          failCount++;
          continue;
        }
        const result = await portal.poHook.acknowledgePO(id);
        if (result?.success) successCount++;
        else failCount++;
      }
      portal.addToast(
        failCount === 0 ? 'success' : (successCount === 0 ? 'error' : 'info'),
        `Acknowledged ${successCount} of ${selectedItemIds.length} selected purchase order(s)${failCount ? ` — ${failCount} could not be acknowledged` : ''}.`
      );
    } else if (action === 'Download') {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const headers = {};
      const token = localStorage.getItem('jwt_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;

      for (const key of selectedItemIds) {
        const invoice = (state.invoices || []).find(i => i.invoiceNumber === key || i.no === key || i.id === key);
        if (!invoice) {
          failCount++;
          continue;
        }
        try {
          const response = await fetch(`${baseUrl}/reports/invoice/${invoice.id}`, { headers });
          if (!response.ok) throw new Error('Download failed');
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `invoice-${invoice.invoiceNumber || invoice.id}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.URL.revokeObjectURL(url);
          successCount++;
        } catch (e) {
          failCount++;
        }
      }
      portal.addToast(
        failCount === 0 ? 'success' : (successCount === 0 ? 'error' : 'info'),
        `Downloaded ${successCount} of ${selectedItemIds.length} selected invoice PDF(s)${failCount ? ` — ${failCount} unavailable` : ''}.`
      );
    }

    setSelectedItemIds([]);
  };

  return (
    <ErrorBoundary>
      <>
        <div className="space-y-6 max-w-full animate-fade-in pb-12">

        {/* ERROR STATUS RECOVERY BANNER */}
        {apiError && (
          <div className="bg-red-50/80 border border-red-200 p-3 rounded-xl text-red-950 animate-slide-down shadow-[0_1px_4px_rgba(10,15,46,0.08)]">
            <div className="flex items-start gap-2.5">
              <AlertCircle className="size-4 text-red-700 shrink-0 mt-0.5" />
              <div className="space-y-1.5 flex-1">
                <h4 className="text-xs font-bold tracking-tight">Can&apos;t reach your buyer&apos;s system ({apiError.code})</h4>
                <p className="text-[11px] text-red-800 leading-normal font-mono bg-red-100/50 p-1.5 rounded border border-red-200/50">
                  {apiError.message}
                </p>
                <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
                  <button
                    onClick={handleRetryConnection}
                    disabled={isRetrying}
                    className="flex items-center gap-1 bg-red-700 hover:bg-red-800 disabled:bg-red-800/80 text-white font-bold text-[9px] px-2.5 py-1 rounded-md transition-all duration-150 cursor-pointer shadow-xs select-none"
                  >
                    <RefreshCw className={`size-2.5 ${isRetrying ? 'animate-spin' : ''}`} />
                    <span>{isRetrying ? 'Reconnecting...' : 'Reconnect & Retry'}</span>
                  </button>
                  <button
                    onClick={() => setApiError(null)}
                    className="text-red-800 hover:text-red-950 font-bold text-[9px] hover:underline cursor-pointer"
                  >
                    Ignore & Work Offline
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 1. TOP HEADER & MAIN BUTTON ACTIONS */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div>
            <h2 className="page-title select-none">Vendor Dashboard</h2>
            <p className="text-text-tertiary text-[11px] mt-0.5 font-medium" suppressHydrationWarning>
              Your account overview &mdash; {shortDate(today)} &bull; {fiscalLabel(today)}
            </p>
          </div>

          {/* INTERACTIVE STATE CONTROLS */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* CONNECTION STATE TOGGLE */}
            <button
              onClick={toggleConnection}
              title="Click to toggle the connection state"
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-all duration-150 cursor-pointer h-7 ${apiError
                ? 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400 animate-pulse hover:bg-red-500/20'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
                }`}
            >
              {apiError ? <WifiOff className="size-3" /> : <Wifi className="size-3" />}
              <span>{apiError ? 'Disconnected' : 'Connected'}</span>
            </button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleFetchPOs}
            >
              <RefreshCw className="size-3" />
              <span>Sync</span>
            </Button>

            <Button variant="default" size="sm" onClick={() => setActiveTab('invoices')}>
              <FileText className="size-3" />
              <span>View Invoices</span>
            </Button>
          </div>
        </div>

        {/* 2. WELCOME BANNER — a real card with an accent wash, not a hardcoded
            solid-color block (was bg-[#3730A3] dark:bg-[#B8860B], invisible to
            per-tenant branding and unrelated to the rest of the token system). */}
        <div
          className="card p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
          style={{ backgroundColor: 'var(--color-emerald-dim)' }}
        >
          <div>
            <p className="text-[10px] uppercase tracking-wider text-emerald-text font-bold mb-1">Welcome back</p>
            <h3 className="page-title mb-2">
              {profile.companyName || '—'}
            </h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-secondary">
              <span>Supplier ID: <strong className="font-mono text-text-primary">{profile.sapVendorCode || profile.vendorId || '—'}</strong></span>
              <span className="text-text-tertiary">|</span>
              <span>GSTIN: <strong className="font-mono text-text-primary">{profile.gstin || '—'}</strong></span>
              {(apiError || profile.status) && (
                <span className="px-1.5 py-0.5 rounded-md bg-surface text-text-primary border border-border text-[9px] font-bold flex items-center gap-1 font-sans">
                  <span className={`size-1.5 rounded-full ${apiError ? 'bg-red-500' : profile.status === 'Approved' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
                  {apiError ? 'Disconnected' : profile.status}
                </span>
              )}
            </div>
          </div>

          {/* QUICK ICON SHORTCUTS */}
          <div className="flex flex-wrap items-stretch gap-2 border-t border-border pt-4 lg:border-t-0 lg:pt-0">
            {[
              { label: 'View Invoices', tab: 'invoices', icon: Receipt },
              { label: 'View RFQs', tab: 'rfqs', icon: FileText },
              { label: 'Statement', tab: 'payments', icon: CreditCard },
              { label: 'TDS Certificates', tab: 'payments', icon: FileCheck }
            ].map((action, idx) => {
              const IconComp = action.icon;
              return (
                <button
                  key={idx}
                  onClick={() => setActiveTab(action.tab)}
                  className="flex flex-col items-center justify-center min-w-[76px] px-2.5 py-2 rounded-lg bg-surface/60 hover:bg-surface transition-colors text-center cursor-pointer text-text-secondary hover:text-text-primary gap-1.5 border border-transparent hover:border-border"
                >
                  <IconComp className="size-4 shrink-0" />
                  <span className="text-[9px] font-bold leading-tight uppercase tracking-tight whitespace-nowrap">{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. 4 STAT CARDS KPI ROW */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {isLoading ? (
            <div className="col-span-full">
              <SkeletonLoader type="card" count={4} />
            </div>
          ) : (
            <>
              {/* Stat Card 1: Open POs */}
              <div className="animate-fade-in animate-stagger-1">
                <KPICard
                  label="Open POs"
                  value={<span className="tabular-nums">{openPOCount}</span>}
                  icon={ShoppingBag}
                  sub={toAcknowledge.length ? `${toAcknowledge.length} awaiting acknowledgement` : 'all acknowledged'}
                />
              </div>

              {/* Stat Card 2: Pending Invoices */}
              <div className="animate-fade-in animate-stagger-2">
                <KPICard
                  label="Pending Invoices"
                  value={<span className="tabular-nums">{pendingInvoicesCount}</span>}
                  icon={Receipt}
                  sub={pendingInvoicesCount ? 'goods receipts to invoice' : 'nothing to invoice'}
                />
              </div>

              {/* Stat Card 3: Awaiting payment */}
              <div className="animate-fade-in animate-stagger-3">
                <KPICard
                  label="Awaiting Payment"
                  value={<span className="tabular-nums">{inrCompact(unpaidTotal)}</span>}
                  icon={CreditCard}
                  sub={`${plural(unpaidInvoices.length, 'invoice')} not yet cleared`}
                />
              </div>

              {/* Stat Card 4: Performance Score */}
              <div className="animate-fade-in animate-stagger-4">
                <KPICard
                  label="Performance Score"
                  value={
                    <span className="tabular-nums">
                      {hasPerformance ? performance.weightedScore : '—'}
                      <span className="text-[16px] text-text-tertiary font-normal ml-1">/ 100</span>
                    </span>
                  }
                  icon={Activity}
                  sub={performance.grade ? `Grade ${performance.grade}` : undefined}
                />
              </div>
            </>
          )}
        </div>

        {/* 4. ALERTS & NOTIFICATIONS (2x2 Grid Panel) */}
        <div className="card overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-border">
            <h4 className="label mb-0">Alerts &amp; Notifications</h4>
          </div>

          {isLoading ? (
            <div className="p-3 space-y-2 animate-pulse">
              <div className="skeleton h-3 rounded w-2/3"></div>
              <div className="skeleton h-2.5 rounded w-1/4"></div>
            </div>
          ) : alerts.length === 0 ? (
            renderEmptyState(
              'All Action Items Cleared',
              'You have no pending alerts or notifications.',
              CheckCircle2
            )
          ) : (
            /* VERTICAL ALERTS FEED */
            <div className="flex flex-col divide-y divide-border/50">
              {alerts.map((alert, idx) => {
                const Icon = alert.icon;
                return (
                  <div key={idx} className="p-4 flex items-start gap-4 hover:bg-surface2 transition-colors duration-200 cursor-pointer" onClick={() => setActiveTab(alert.tab)}>
                    <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 border ${alert.iconColor} shadow-sm`}>
                      <Icon className="size-4" />
                    </div>
                    <div className="space-y-1 flex-1">
                      <div className="flex justify-between items-start">
                        <h5 className="font-bold text-[13px] text-text-primary">{alert.title}</h5>
                        <span className="text-[10px] text-text-tertiary font-mono tracking-wide uppercase">New</span>
                      </div>
                      <p className="text-[12px] text-text-secondary leading-relaxed pr-8">{alert.desc}</p>
                      <button
                        onClick={(e) => { e.stopPropagation(); setActiveTab(alert.tab); }}
                        className="text-emerald-text font-bold text-[11px] flex items-center gap-1 hover:underline pt-1.5 transition-colors duration-150"
                      >
                        <span>{alert.actionText}</span>
                        <ChevronRight className="size-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 5. SIDE-BY-SIDE: RECENT POs & RECENT INVOICES */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* RECENT PURCHASE ORDERS */}
          <div className="card overflow-hidden flex flex-col">
            <div className="px-3.5 py-2.5 border-b border-border flex items-center justify-between">
              <h4 className="label mb-0">
                Purchase Orders Monitor
              </h4>
              <button
                onClick={() => setActiveTab('pos')}
                className="text-[11px] text-text-tertiary hover:text-text-primary hover:underline font-semibold cursor-pointer transition-colors duration-150"
              >
                All Orders
              </button>
            </div>
            {isLoading ? (
              <div className="p-3 space-y-3 animate-pulse">
                <div className="skeleton h-8 rounded"></div>
                <div className="skeleton h-8 rounded"></div>
              </div>
            ) : !state.pos || state.pos.length === 0 ? (
              renderEmptyState(
                'No Active Purchase Orders',
                'No purchase orders have been issued to your company yet.',
                FolderOpen,
                'Check for new orders',
                handleFetchPOs
              )
            ) : (
              <div className="flex flex-col">
                {state.pos.slice(0, 4).map((row, idx) => {
                  const isSelected = selectedItemIds.includes(row.id);
                  return (
                    <div key={idx} className={`group relative p-3 flex items-center justify-between transition-all duration-200 border-b border-border/40 last:border-0 ${isSelected ? 'bg-primary/5' : 'hover:bg-surface2/50'}`}>
                      {/* Selection indicator bar */}
                      <div className={`absolute left-0 top-0 bottom-0 w-1 transition-colors duration-200 ${isSelected ? 'bg-primary' : 'bg-transparent group-hover:bg-border/50'}`} />
                      
                      <div className="flex items-center gap-3.5 min-w-0 pl-2">
                        <div className="flex items-center justify-center shrink-0">
                          <input 
                            type="checkbox" 
                            checked={isSelected}
                            onChange={() => toggleSelection(row.id)}
                            className="size-4 rounded-sm border-border text-primary focus:ring-primary focus:ring-offset-1 focus:ring-offset-surface cursor-pointer bg-base transition-colors"
                          />
                        </div>
                        <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${isSelected ? 'bg-primary/10 text-primary' : 'bg-surface2 text-text-secondary border border-border'}`}>
                          <ShoppingBag className="size-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span 
                            className="font-mono font-bold text-text-primary cursor-pointer hover:text-primary transition-colors text-[12px] tracking-tight" 
                            onClick={() => setDrawerContent({ type: 'PO', data: row })}
                          >
                            {row.id}
                          </span>
                          <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                            <span className="font-medium text-text-secondary">{row.items?.[0]?.description || 'Material Order'}</span> 
                            <span className="mx-1.5 opacity-50">&bull;</span> 
                            {row.items?.[0]?.quantity || 0} {row.items?.[0]?.uom || 'EA'}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0 text-right pr-1">
                        <div className="hidden sm:block">
                          <p className="font-mono font-bold text-text-primary text-[12px] tabular-nums tracking-tight">{inr((row.items || []).reduce((sum, item) => sum + money(item.netValue), 0))}</p>
                          <p className="text-[10px] text-text-tertiary font-mono mt-0.5 tabular-nums">{shortDate(row.createdDate)}</p>
                        </div>
                        <StatusBadge label={row.status} variant={poStatusVariant(row.status)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* RECENT INVOICES */}
          <div className="card overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-surface/50">
              <h4 className="text-[12px] font-bold text-text-primary uppercase tracking-wider mb-0 flex items-center gap-2">
                <Receipt className="size-4 text-text-tertiary" />
                Logistics Invoices Ledger
              </h4>
              <button
                onClick={() => setActiveTab('invoices')}
                className="text-[11px] text-text-tertiary hover:text-primary font-medium cursor-pointer transition-colors duration-150 flex items-center gap-1"
              >
                All Invoices <ChevronRight className="size-3" />
              </button>
            </div>
            {isLoading ? (
              <div className="p-4 space-y-4 animate-pulse">
                <div className="skeleton h-10 rounded-lg"></div>
                <div className="skeleton h-10 rounded-lg"></div>
              </div>
            ) : !state.invoices || state.invoices.length === 0 ? (
              renderEmptyState(
                'No Invoices Logged',
                'No invoices yet. Once your buyer\'s finance team posts one against a delivery, it will appear here.',
                FileText,
                'View Invoices',
                () => setActiveTab('invoices')
              )
            ) : (
              <div className="flex flex-col">
                {state.invoices.slice(0, 4).map((row, idx) => {
                  const isSelected = selectedItemIds.includes(row.invoiceNumber || row.no);
                  return (
                    <div key={idx} className={`group relative p-3 flex items-center justify-between transition-all duration-200 border-b border-border/40 last:border-0 ${isSelected ? 'bg-primary/5' : 'hover:bg-surface2/50'}`}>
                      {/* Selection indicator bar */}
                      <div className={`absolute left-0 top-0 bottom-0 w-1 transition-colors duration-200 ${isSelected ? 'bg-primary' : 'bg-transparent group-hover:bg-border/50'}`} />
                      
                      <div className="flex items-center gap-3.5 min-w-0 pl-2">
                        <div className="flex items-center justify-center shrink-0">
                          <input 
                            type="checkbox" 
                            checked={isSelected}
                            onChange={() => toggleSelection(row.invoiceNumber || row.no)}
                            className="size-4 rounded-sm border-border text-primary focus:ring-primary focus:ring-offset-1 focus:ring-offset-surface cursor-pointer bg-base transition-colors"
                          />
                        </div>
                        <div className={`size-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${isSelected ? 'bg-primary/10 text-primary' : 'bg-surface2 text-text-secondary border border-border'}`}>
                          <Receipt className="size-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <span 
                            className="font-mono font-bold text-text-primary cursor-pointer hover:text-primary transition-colors text-[12px] tracking-tight" 
                            onClick={() => setDrawerContent({ type: 'Invoice', data: row })}
                          >
                            {row.invoiceNumber || row.no}
                          </span>
                          <p className="text-[11px] text-text-tertiary truncate mt-0.5">
                            Ref PO: <strong className="font-mono font-bold text-text-secondary">{row.poId}</strong>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 shrink-0 text-right pr-1">
                        <div className="hidden sm:block">
                          <p className="font-mono font-bold text-text-primary text-[12px] tabular-nums tracking-tight">{inr(row.totalAmount)}</p>
                          <p className="text-[10px] text-text-tertiary font-mono mt-0.5 tabular-nums">{shortDate(row.invoiceDate)}</p>
                        </div>
                        <StatusBadge label={row.status} variant={invoiceStatusVariant(row.status)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 6. SIDE-BY-SIDE: PERFORMANCE BAR INDICATORS & RECENT PAYMENTS */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

          {/* MY PERFORMANCE SCORING BARS */}
          <div className="lg:col-span-5 card p-3.5 flex flex-col justify-between min-h-[300px]">
            <div>
              <h4 className="label mb-0 border-b border-border pb-2">
                Service Delivery KPIs (OTIF)
              </h4>

              {isLoading ? (
                <div className="space-y-3 pt-3 animate-pulse">
                  <div className="skeleton h-5 rounded"></div>
                  <div className="skeleton h-5 rounded"></div>
                  <div className="skeleton h-5 rounded"></div>
                </div>
              ) : !hasPerformance ? (
                <p className="pt-3 text-[11px] text-text-tertiary">
                  Scores appear once you have delivered and invoiced against a purchase order.
                </p>
              ) : (
                /* INDICATORS SCALE — the three measures GET /vendors/performance computes */
                <div className="space-y-3 pt-3">
                  {[
                    { name: 'On-Time In-Full Delivery (OTIF)', score: money(performance.deliveryOTIF), target: 95 },
                    { name: 'Quality Acceptance Rate', score: money(performance.qualityAcceptance), target: 95 },
                    { name: 'Invoice Billing Accuracy', score: money(performance.invoiceAccuracy), target: 90 },
                  ].map((m) => {
                    const meets = m.score >= m.target;
                    return (
                      <div key={m.name} className="space-y-1">
                        <div className="flex justify-between text-[11px] font-bold">
                          <span className="text-text-primary">{m.name}</span>
                          <span className="text-text-secondary tabular-nums">
                            {m.score}% <span className="text-text-tertiary font-normal">/ target {m.target}%</span>
                            {meets && <span className="text-xs ml-0.5">✓</span>}
                          </span>
                        </div>
                        <div className="w-full bg-surface2 h-1.5 rounded-full border border-border overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${meets ? 'bg-emerald-500' : 'bg-amber-500'}`}
                            style={{ width: `${Math.min(100, m.score)}%` }}
                          ></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* OVERALL PERFORMANCE CARD SCORE */}
            {hasPerformance && (
              <div className="mt-3 bg-surface2/50 border border-border p-2.5 rounded-xl flex items-center justify-between">
                <div>
                  <span className="label mb-0">Overall Score</span>
                  <p className="text-base font-bold text-text-primary font-mono mt-0.5 tabular-nums">
                    {performance.weightedScore} <span className="text-[11px] font-normal text-text-tertiary font-sans">/ 100</span>
                  </p>
                </div>
                {performance.grade && (
                  <span className="px-2 py-0.5 rounded-md border border-border bg-surface2 text-text-primary text-[10px] font-semibold uppercase tracking-wider font-sans">
                    Grade {performance.grade}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* RECENT PAYMENTS RECEIVED */}
          <div className="lg:col-span-7 card overflow-hidden flex flex-col justify-between min-h-[300px]">
            <div>
              <div className="px-3.5 py-2.5 border-b border-border flex items-center justify-between">
                <h4 className="label mb-0">
                  Treasury Disbursements (Recent)
                </h4>
                <button
                  onClick={() => setActiveTab('payments')}
                  className="text-[11px] text-text-tertiary hover:text-text-primary hover:underline font-semibold cursor-pointer transition-colors duration-150"
                >
                  Statement
                </button>
              </div>
              {/* state.payments is null until usePayments' first fetch answers
                  (issue #111) — distinct from [], a vendor confirmed to have
                  no payments. Rendering the empty state for null told a
                  supplier who simply hadn't loaded yet that they had never
                  been paid. */}
              {isLoading || state.payments === null ? (
                <div className="p-3 space-y-3 animate-pulse">
                  <div className="skeleton h-8 rounded"></div>
                  <div className="skeleton h-8 rounded"></div>
                </div>
              ) : state.payments.length === 0 ? (
                renderEmptyState(
                  'No Disbursement Logs',
                  'No payments yet. Payments are released 45 days after your buyer approves an invoice.',
                  CreditCard
                )
              ) : (
                <div className="flex flex-col">
                  {state.payments.slice(0, 3).map((row, idx) => {
                    // No invented UTR. This used to fall back to `UTR${Date.now()}`,
                    // which both read the clock during render (impure) and put a
                    // string indistinguishable from a real bank reference on screen
                    // for a payment that has none yet — the same reason PO creation
                    // stopped minting fake SAP order numbers.
                    const utr = row.utrCode || row.utr || '—';
                    const invNumber = row.invoiceNumber || row.invoiceId || '—';
                    const method = row.paymentMethod || '—';
                    const grossVal = money(row.grossAmount);
                    const tdsVal = money(row.tdsDeducted);
                    const netVal = money(row.netAmount);
                    const payDate = shortDate(row.paymentDate);

                    return (
                      <div key={idx} className="p-2.5 flex items-center justify-between hover:bg-surface2 transition-colors duration-150 even:bg-surface2/30">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="size-6 rounded bg-[#F0FDF4] border border-[#BBF7D0] flex items-center justify-center text-[#16A34A] shrink-0">
                            <CreditCard className="size-3.5" />
                          </div>
                          <div className="min-w-0">
                            <span className="font-mono font-bold text-text-primary cursor-pointer hover:underline text-[11px]" onClick={() => setActiveTab('payments')}>
                              {utr}
                            </span>
                            <p className="text-[11px] text-text-tertiary mt-0.5 font-semibold">
                              Inv: <strong className="font-mono font-bold">{invNumber}</strong> &bull; {method}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 shrink-0 text-right">
                          <div className="hidden sm:block text-[10px] text-text-tertiary font-semibold">
                            <p>Gross: <span className="font-mono text-text-primary tabular-nums">{inr(grossVal)}</span></p>
                            <p>TDS: <span className="font-mono text-destructive tabular-nums">-{inr(tdsVal)}</span></p>
                          </div>
                          <div>
                            <p className="font-mono font-bold text-[#16A34A] text-[11px] tabular-nums">{inr(netVal)}</p>
                            <p className="text-[10px] text-text-tertiary font-mono mt-0.5 tabular-nums">{payDate}</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ACTION BUTTON CLEARING BARS */}
            <div className="p-2.5 bg-surface2/50 border-t border-border grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => downloadFromApi('/reports/statement', 'account-statement.pdf')
                  .catch((err) => portal.addToast('error', `Could not download the statement: ${err.message}`))}
                className="justify-center border border-transparent hover:border-border"
              >
                <Download className="size-3" />
                <span>Download Advice</span>
              </Button>
              <Button variant="default" size="sm" onClick={() => setActiveTab('payments')} className="justify-center">
                <FileCheck className="size-3" />
                <span>Form 16A / TDS</span>
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* FLOATING ACTION BAR */}
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 transform ${selectedItemIds.length > 0 ? 'translate-y-0 opacity-100 scale-100' : 'translate-y-10 opacity-0 scale-95 pointer-events-none'}`}>
        <div className="bg-surface shadow-2xl border border-border rounded-full px-4 py-2.5 flex items-center gap-4 text-[13px] font-medium animate-fade-in">
          <div className="flex items-center gap-2 px-2 border-r border-border">
            <span className="flex items-center justify-center size-5 bg-primary text-white rounded-full text-[11px] font-bold">
              {selectedItemIds.length}
            </span>
            <span className="text-text-primary">Selected</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => handleBulkAction('Download')} className="h-7 text-[11px] rounded-full px-3">
              <Download className="size-3 mr-1.5" />
              Download PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => handleBulkAction('Acknowledge')} className="h-7 text-[11px] rounded-full px-3 text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50">
              <CheckCircle2 className="size-3 mr-1.5" />
              Acknowledge
            </Button>
          </div>
          <button 
            onClick={() => setSelectedItemIds([])}
            className="p-1 hover:bg-surface2 rounded-full text-text-tertiary transition-colors ml-2"
          >
            <AlertCircle className="size-4 rotate-45" />
          </button>
        </div>
      </div>

      {/* DETAILS DRAWER */}
      <Drawer 
        isOpen={!!drawerContent} 
        onClose={() => setDrawerContent(null)}
        title={
          <div className="flex items-center gap-2">
            {drawerContent?.type === 'PO' ? <ShoppingBag className="size-4 text-primary" /> : <Receipt className="size-4 text-primary" />}
            <span>{drawerContent?.type === 'PO' ? `Purchase Order Details` : `Invoice Details`}</span>
          </div>
        }
      >
        {drawerContent && (
          <div className="space-y-8 pb-8">
            {/* Header Section */}
            <div className="flex flex-col gap-3">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-2xl font-bold text-text-primary font-mono tracking-tight">
                    {drawerContent.type === 'PO' ? drawerContent.data.id : (drawerContent.data.invoiceNumber || drawerContent.data.no)}
                  </h3>
                  <p className="text-[13px] text-text-tertiary mt-1 flex items-center gap-1.5">
                    <Calendar className="size-3.5" />
                    {shortDate(drawerContent.type === 'PO' ? drawerContent.data.createdDate : drawerContent.data.invoiceDate)}
                  </p>
                </div>
                <div className="pt-1">
                  <StatusBadge 
                    label={drawerContent.data.status} 
                    variant={drawerContent.type === 'PO' ? poStatusVariant(drawerContent.data.status) : invoiceStatusVariant(drawerContent.data.status)} 
                  />
                </div>
              </div>
            </div>

            {/* Financial Summary */}
            <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="bg-surface2/50 px-4 py-2.5 border-b border-border">
                <h4 className="text-[11px] font-bold uppercase tracking-widest text-text-secondary flex items-center gap-2">
                  <CreditCard className="size-3.5" />
                  Financial Summary
                </h4>
              </div>
              <div className="p-4 flex justify-between items-end">
                <div className="space-y-1">
                  <span className="text-[12px] text-text-tertiary">Total Net Value</span>
                  <p className="text-2xl font-mono font-bold text-text-primary tracking-tight">
                    {inr(drawerContent.type === 'PO'
                      ? (drawerContent.data.items || []).reduce((sum, item) => sum + money(item.netValue), 0)
                      : drawerContent.data.totalAmount)}
                  </p>
                </div>
                <div className="text-right space-y-1">
                  <span className="text-[12px] text-text-tertiary">Items</span>
                  <p className="text-[14px] font-mono font-medium text-text-secondary">
                    {drawerContent.data.items?.length ?? 0}
                  </p>
                </div>
              </div>
            </div>

            {/* Line Items */}
            <div className="space-y-3">
              <h4 className="text-[11px] font-bold uppercase tracking-widest text-text-secondary flex items-center gap-2 px-1">
                <FileText className="size-3.5" />
                Line Items
              </h4>
              
              <div className="border border-border rounded-xl overflow-hidden divide-y divide-border bg-surface">
                {drawerContent.data.items?.map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center p-3.5 hover:bg-surface2/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="size-8 rounded bg-base border border-border flex items-center justify-center text-text-tertiary font-mono text-[10px] shrink-0">
                        {String(idx + 1).padStart(2, '0')}
                      </div>
                      <div>
                        <p className="font-semibold text-[13px] text-text-primary">{item.description}</p>
                        <p className="text-[11px] text-text-tertiary mt-0.5 flex items-center gap-1.5">
                          <span className="font-mono bg-surface2 px-1.5 py-0.5 rounded text-[10px]">{item.quantity} {item.uom}</span>
                          {item.materialCode && <span>&bull; {item.materialCode}</span>}
                        </p>
                      </div>
                    </div>
                    <span className="font-mono font-medium text-[13px] text-text-primary">
                      {inr(item.netValue ?? item.amount)}
                    </span>
                  </div>
                )) || (
                  <div className="p-6 text-center text-text-tertiary flex flex-col items-center gap-2">
                    <FolderOpen className="size-6 opacity-50" />
                    <p className="text-[12px]">Line item details not available in this preview.</p>
                  </div>
                )}
              </div>
            </div>
            
            {/* Actions */}
            <div className="pt-6 flex gap-3">
              <Button variant="outline" className="flex-1 border-border hover:bg-surface2" onClick={() => setDrawerContent(null)}>
                Close
              </Button>
              <Button className="flex-1" onClick={() => { setDrawerContent(null); setActiveTab(drawerContent.type === 'PO' ? 'pos' : 'invoices'); }}>
                Open Full Module &rarr;
              </Button>
            </div>
          </div>
        )}
      </Drawer>

      </>
    </ErrorBoundary>
  );
}
