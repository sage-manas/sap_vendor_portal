import React, { useState, useEffect } from 'react';
import { usePortal } from '@/lib/portal-context';
import ErrorBoundary from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';
import StatusBadge from '@/components/ui/StatusBadge';
import Drawer from '@/components/ui/Drawer';
import DataTable from '@/components/ui/DataTable';
import TableSkeleton from '@/components/ui/TableSkeleton';
import { PageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Card';
import { Meter } from '@/components/ui/controls';
import { poStatusVariant, invoiceStatusVariant } from '@/lib/statusColors';
import { downloadFromApi } from '@/lib/download';
import { CheckCircle2, ChevronRight, Download, RefreshCw, X } from 'lucide-react';

// Amounts arrive as Decimal strings from the API (utils/money.js on the server).
const money = (value) => Number(value) || 0;

const inr = (value) =>
  `₹${money(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const amount = (value) => money(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

const poTotal = (po) => (po.items || []).reduce((sum, item) => sum + money(item.netValue), 0);

// What a task's dot means: waiting on you, or something to look at.
const TASK_TONE = { warning: 'bg-warning', acknowledge: 'bg-accent-solid', invoice: 'bg-accent-solid', ship: 'bg-accent-solid', rfq: 'bg-accent-solid' };

export default function DashboardView({ state, setActiveTab }) {
  const portal = usePortal();

  const [isLoading, setIsLoading] = useState(true);
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
    });
  }
  if (toAcknowledge.length > 0) {
    alerts.push({
      type: 'acknowledge',
      title: `${plural(toAcknowledge.length, 'purchase order')} awaiting acknowledgement (${listIds(toAcknowledge, po => po.id)})`,
      desc: 'Confirm you accept the order so the buyer knows it is in hand.',
      actionText: 'Acknowledge',
      tab: 'pos',
    });
  }
  if (pendingInvoices.length > 0) {
    alerts.push({
      type: 'invoice',
      title: `${plural(pendingInvoices.length, 'goods receipt')} awaiting invoice (${listIds(pendingInvoices, g => g.id)})`,
      desc: 'Submit your invoice against these goods receipts so payment can be processed.',
      actionText: 'Submit invoice',
      tab: 'pos',
    });
  }
  if (toShip.length > 0) {
    alerts.push({
      type: 'ship',
      title: `${plural(toShip.length, 'acknowledged order')} ready to ship (${listIds(toShip, po => po.id)})`,
      desc: 'Send the shipment notice when goods leave your dock, so the goods receipt can be matched.',
      actionText: 'Send shipment',
      tab: 'pos',
    });
  }
  if (openRfqs.length > 0) {
    alerts.push({
      type: 'rfq',
      title: `${plural(openRfqs.length, 'RFQ')} open for your quotation (${listIds(openRfqs, rfq => rfq.id)})`,
      desc: `${openRfqs[0].description || 'Request for quotation'}${openRfqs.length > 1 ? ` and ${openRfqs.length - 1} more` : ''}.`,
      actionText: 'Submit quotation',
      tab: 'rfqs',
    });
  }

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

  // The two lists share one selection, so each table only sees its own ids.
  const invoiceKey = (inv) => inv.invoiceNumber || inv.no;
  const poIds = new Set(pos.map((p) => p.id));
  const invoiceKeys = new Set(invoices.map(invoiceKey));
  const setSelectionWithin = (keys) => (next) =>
    setSelectedItemIds((prev) => [...prev.filter((id) => !keys.has(id)), ...next]);

  const orderColumns = [
    { key: 'id', header: 'Order', mono: true, primary: true },
    { key: 'material', header: 'Material', wrap: true, render: (row) => <span className="text-fg">{row.items?.[0]?.description || '—'}</span> },
    { key: 'date', header: 'Raised', render: (row) => shortDate(row.createdDate) },
    { key: 'value', header: 'Value (₹)', align: 'right', render: (row) => <span className="mono">{amount(poTotal(row))}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.status} variant={poStatusVariant(row.status)} /> },
  ];

  const invoiceColumns = [
    { key: 'no', header: 'Invoice', primary: true, render: (row) => <span className="mono">{invoiceKey(row)}</span> },
    { key: 'poId', header: 'Order', mono: true },
    { key: 'date', header: 'Date', render: (row) => shortDate(row.invoiceDate) },
    { key: 'value', header: 'Value (₹)', align: 'right', render: (row) => <span className="mono">{amount(row.totalAmount)}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.status} variant={invoiceStatusVariant(row.status)} /> },
  ];

  const downloadStatement = () => downloadFromApi('/reports/statement', 'account-statement.pdf')
    .catch((err) => portal.addToast('error', `Could not download the statement: ${err.message}`));

  return (
    <ErrorBoundary>
      <div className="pb-16">
        <PageHeader
          title="Overview"
          description={(
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1" suppressHydrationWarning>
              <span className="text-fg">{profile.companyName || '—'}</span>
              <span aria-hidden="true">·</span>
              <span>Supplier ID <span className="mono text-fg">{profile.sapVendorCode || profile.vendorId || '—'}</span></span>
              <span aria-hidden="true">·</span>
              <span>GSTIN <span className="mono text-fg">{profile.gstin || '—'}</span></span>
              {profile.status && <StatusBadge label={profile.status} />}
              <span className="basis-full text-fg-subtle">{shortDate(today)} · {fiscalLabel(today)}</span>
            </span>
          )}
          secondary={(
            <Button variant="secondary" onClick={handleFetchPOs} loading={isLoading}>
              <RefreshCw strokeWidth={1.5} /> Refresh orders
            </Button>
          )}
        />

        <div className="grid gap-x-8 gap-y-10 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-10">
            <Section title="Needs your attention">
              {isLoading ? (
                <div className="card"><TableSkeleton rows={3} cols={2} /></div>
              ) : alerts.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-fg-muted">
                  <CheckCircle2 className="size-4 text-success" strokeWidth={1.5} aria-hidden="true" />
                  Nothing needs your attention right now.
                </p>
              ) : (
                <ul className="card divide-y divide-border">
                  {alerts.map((alert) => (
                    <li key={alert.type} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                      <span className={`mt-1.5 hidden size-2 shrink-0 self-start rounded-full sm:block ${TASK_TONE[alert.type]}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-fg">{alert.title}</p>
                        <p className="text-sm text-fg-muted">{alert.desc}</p>
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => setActiveTab(alert.tab)} className="self-start sm:self-center">
                        {alert.actionText}
                        <ChevronRight strokeWidth={1.5} />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {isLoading ? (
              <div className="card"><TableSkeleton rows={1} cols={4} /></div>
            ) : (
              <KPIStrip>
                <KPICard
                  label="Open orders"
                  value={openPOCount}
                  hint={toAcknowledge.length ? `${toAcknowledge.length} awaiting acknowledgement` : 'All acknowledged'}
                />
                <KPICard label="To invoice" value={pendingInvoicesCount} hint={pendingInvoicesCount ? plural(pendingInvoicesCount, 'goods receipt') : 'Nothing to invoice'} />
                <KPICard
                  label="Awaiting payment"
                  value={<span className="mono">{inr(unpaidTotal)}</span>}
                  empty={!unpaidTotal}
                  hint={unpaidInvoices.length ? `${plural(unpaidInvoices.length, 'invoice')} not yet cleared` : 'Nothing outstanding'}
                />
                <KPICard
                  label="Supplier score"
                  value={hasPerformance ? <>{performance.weightedScore} <span className="text-sm font-medium text-fg-muted">/ 100{performance.grade ? ` · ${performance.grade}` : ''}</span></> : '—'}
                  empty={!hasPerformance}
                  hint={hasPerformance ? undefined : 'After your first delivery'}
                />
              </KPIStrip>
            )}

            {selectedItemIds.length > 0 && (
              <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-popover" role="region" aria-label="Selection">
                <span className="mr-auto text-fg">{selectedItemIds.length} selected</span>
                <Button variant="secondary" size="sm" onClick={() => handleBulkAction('Acknowledge')}>
                  <CheckCircle2 strokeWidth={1.5} /> Acknowledge
                </Button>
                <Button variant="secondary" size="sm" onClick={() => handleBulkAction('Download')}>
                  <Download strokeWidth={1.5} /> Download PDF
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setSelectedItemIds([])} aria-label="Clear selection">
                  <X strokeWidth={1.5} />
                </Button>
              </div>
            )}

            <Section
              title="Recent orders"
              actions={<Button variant="link" onClick={() => setActiveTab('pos')}>All orders</Button>}
            >
              <DataTable
                caption="Recent orders"
                columns={orderColumns}
                rows={pos.slice(0, 5)}
                loading={isLoading}
                selectable
                selected={selectedItemIds.filter((id) => poIds.has(id))}
                onSelectedChange={setSelectionWithin(poIds)}
                onRowClick={(row) => setDrawerContent({ type: 'PO', data: row })}
                rowLabel={(row) => row.id}
                empty={(
                  <span>
                    No purchase orders have been issued to your company yet.{' '}
                    <Button variant="link" onClick={handleFetchPOs}>Check for new orders</Button>
                  </span>
                )}
              />
            </Section>

            <Section
              title="Recent invoices"
              actions={<Button variant="link" onClick={() => setActiveTab('invoices')}>All invoices</Button>}
            >
              <DataTable
                caption="Recent invoices"
                columns={invoiceColumns}
                rows={invoices.slice(0, 5)}
                getRowId={invoiceKey}
                loading={isLoading}
                selectable
                selected={selectedItemIds.filter((id) => invoiceKeys.has(id))}
                onSelectedChange={setSelectionWithin(invoiceKeys)}
                onRowClick={(row) => setDrawerContent({ type: 'Invoice', data: row })}
                rowLabel={invoiceKey}
                empty="No invoices yet — once your buyer’s finance team posts one against a delivery, it appears here."
              />
            </Section>
          </div>

          <aside className="space-y-10">
            <Section
              title="Performance"
              actions={<Button variant="link" onClick={() => setActiveTab('performance')}>Details</Button>}
            >
              {!hasPerformance ? (
                <p className="text-sm text-fg-muted">Scores appear once you have delivered and invoiced against a purchase order.</p>
              ) : (
                <div className="card space-y-4 p-4">
                  {/* The three measures GET /vendors/performance computes. */}
                  <Meter label="On-time in full" value={money(performance.deliveryOTIF)} target={95} />
                  <Meter label="Quality acceptance" value={money(performance.qualityAcceptance)} target={95} />
                  <Meter label="Invoice accuracy" value={money(performance.invoiceAccuracy)} target={90} />
                </div>
              )}
            </Section>

            <Section
              title="Recent payments"
              actions={<Button variant="link" onClick={() => setActiveTab('payments')}>All payments</Button>}
            >
              {/* state.payments is null until usePayments' first fetch answers
                  (issue #111) — distinct from [], a vendor confirmed to have
                  no payments. Rendering the empty state for null told a
                  supplier who simply hadn't loaded yet that they had never
                  been paid. */}
              {isLoading || state.payments === null ? (
                <div className="card"><TableSkeleton rows={2} cols={2} /></div>
              ) : state.payments.length === 0 ? (
                <p className="text-sm text-fg-muted">No payments yet. Payments are released 45 days after your buyer approves an invoice.</p>
              ) : (
                <div className="card">
                  <ul className="divide-y divide-border">
                    {state.payments.slice(0, 3).map((row, idx) => (
                      // No invented UTR. This used to fall back to `UTR${Date.now()}`,
                      // which both read the clock during render (impure) and put a
                      // string indistinguishable from a real bank reference on screen
                      // for a payment that has none yet.
                      <li key={row.id || idx} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                        <div className="min-w-0">
                          <p className="mono truncate text-fg" title="UTR">{row.utrCode || row.utr || '—'}</p>
                          <p className="text-xs text-fg-subtle">
                            {(row.invoiceNumber || row.invoiceId) && <><span className="mono">{row.invoiceNumber || row.invoiceId}</span> · </>}
                            {shortDate(row.paymentDate)} · {row.paymentMethod || '—'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="mono text-fg">{inr(row.netAmount)}</p>
                          {money(row.tdsDeducted) > 0 && <p className="text-xs text-fg-subtle">TDS <span className="mono">{inr(row.tdsDeducted)}</span></p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-border px-4 py-2">
                    <Button variant="link" onClick={downloadStatement}>Download statement (PDF)</Button>
                  </div>
                </div>
              )}
            </Section>
          </aside>
        </div>
      </div>

      {/* DETAILS DRAWER */}
      <Drawer
        isOpen={!!drawerContent}
        onClose={() => setDrawerContent(null)}
        title={drawerContent ? (drawerContent.type === 'PO' ? drawerContent.data.id : (drawerContent.data.invoiceNumber || drawerContent.data.no)) : ''}
        description={drawerContent ? `${drawerContent.type === 'PO' ? 'Purchase order' : 'Invoice'} · ${shortDate(drawerContent.type === 'PO' ? drawerContent.data.createdDate : drawerContent.data.invoiceDate)}` : undefined}
        footer={drawerContent && (
          <>
            <Button variant="ghost" onClick={() => setDrawerContent(null)}>Close</Button>
            <Button onClick={() => { setDrawerContent(null); setActiveTab(drawerContent.type === 'PO' ? 'pos' : 'invoices'); }}>
              Open in {drawerContent.type === 'PO' ? 'Orders' : 'Invoices'}
            </Button>
          </>
        )}
      >
        {drawerContent && (
          <div className="space-y-6">
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2.5">
              <dt className="text-fg-muted">Status</dt>
              <dd>
                <StatusBadge
                  label={drawerContent.data.status}
                  variant={drawerContent.type === 'PO' ? poStatusVariant(drawerContent.data.status) : invoiceStatusVariant(drawerContent.data.status)}
                />
              </dd>
              <dt className="text-fg-muted">Total value</dt>
              <dd className="mono text-fg">
                {inr(drawerContent.type === 'PO' ? poTotal(drawerContent.data) : drawerContent.data.totalAmount)}
              </dd>
              <dt className="text-fg-muted">Lines</dt>
              <dd className="mono">{drawerContent.data.items?.length ?? 0}</dd>
            </dl>

            <div>
              <h3 className="mb-2 text-sm font-medium text-fg">Line items</h3>
              {drawerContent.data.items?.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {drawerContent.data.items.map((item, idx) => (
                    <li key={idx} className="flex items-start justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-fg">{item.description}</p>
                        <p className="text-xs text-fg-subtle">
                          <span className="mono">{item.quantity} {item.uom}</span>
                          {item.materialCode && <> · <span className="mono">{item.materialCode}</span></>}
                        </p>
                      </div>
                      <span className="mono text-fg">{inr(item.netValue ?? item.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-fg-muted">Line item details aren’t available here.</p>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </ErrorBoundary>
  );
}
