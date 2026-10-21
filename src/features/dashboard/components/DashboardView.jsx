import React, { useState } from 'react';
import { usePortal } from '@/lib/portal-context';
import ErrorBoundary from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import KPICard from '@/components/ui/KPICard';
import StatusBadge from '@/components/ui/StatusBadge';
import Drawer from '@/components/ui/Drawer';
import DataTable from '@/components/ui/DataTable';
import TableSkeleton from '@/components/ui/TableSkeleton';
import { PageHeader } from '@/components/ui/Page';
import Card, { Section } from '@/components/ui/Card';
import { SegmentedControl } from '@/components/ui/controls';
import { DocumentHero, MeterPillRow, StatTile } from '@/components/ui/dashboard';
import { SplineChart } from '@/components/ui/charts';
import { MEASURES } from './PerformanceView';
import { poStatusVariant, invoiceStatusVariant } from '@/lib/statusColors';
import { downloadFromApi } from '@/lib/download';
import { CheckCircle2, ChevronRight, Download, RefreshCw, X } from 'lucide-react';
import { displayDate } from '@/lib/displayDate';
import { paymentInvoiceLabel } from '@/lib/paymentInvoiceLabel';
import { formatAmount, formatMoney } from '@/lib/money';

// Amounts arrive as Decimal strings from the API (utils/money.js on the server).
const money = (value) => Number(value) || 0;



// Indian fiscal year runs April to March; Q1 is April–June.
const fiscalLabel = (date) => {
  const month = date.getMonth();
  const startYear = month >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  const quarter = Math.floor(((month + 9) % 12) / 3) + 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')} Q${quarter}`;
};

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Up to three document ids as a sample, with the rest counted. `total` is
// the server's count, which is the authority — the rows are only there to
// name a few of them.
const listIds = (rows, idOf, total) =>
  rows.slice(0, 3).map(idOf).join(', ') + (total > 3 ? ` +${total - 3}` : '');

const poTotal = (po) => (po.items || []).reduce((sum, item) => sum + money(item.netValue), 0);

// Invoiced and paid per calendar month — the server's series (it answers
// twelve months; the control offers six or twelve, so the tail is taken
// here), labelled for the chart.
//
// This used to be computed in the browser from `state.invoices` and
// `state.payments`, which held one page of each list: every month in the
// chart was the total of whichever documents were on that page, and the
// older months read as quiet when they were simply absent (issue #280).
const flowRows = (flow, months) => (flow || []).slice(-months).map((row) => ({
  label: new Date(`${row.month}-01T00:00:00`).toLocaleString('en-IN', { month: 'short' }),
  invoiced: money(row.invoiced),
  paid: money(row.paid),
}));

const PILL_STYLES = ['solid', 'inverse', 'muted', 'hatched'];

// What a task's dot means: waiting on you, or something to look at.
const TASK_TONE = { warning: 'bg-warning', acknowledge: 'bg-accent-solid', invoice: 'bg-accent-solid', ship: 'bg-accent-solid', rfq: 'bg-accent-solid' };

export default function DashboardView({ state, setActiveTab }) {
  const portal = usePortal();

  const [drawerContent, setDrawerContent] = useState(null); // { type: 'PO' | 'Invoice', data: any }
  const [selectedItemIds, setSelectedItemIds] = useState([]);
  const [flowMonths, setFlowMonths] = useState('6');

  // "Today" for the header, sampled once per mount so a render stays a
  // function of its inputs (the same rule ReportsAnalyticsView follows).
  const [today] = useState(() => new Date());

  // Nothing on this screen may be a constant standing in for data: a supplier
  // reads these figures as statements about their account.
  //
  // Every count and total comes from `state.summary` — the server's own
  // counts and sums (GET /api/dashboard/summary). They used to be computed
  // here from `state.pos` / `state.invoices` / `state.grns` / `state.rfqs`,
  // which each hold one page of a list endpoint, so a supplier with more
  // than a page of documents of any kind read "Open orders", "To invoice",
  // "Awaiting payment", the pipeline tiles and the chart as figures over
  // their newest twenty (issue #280). The arrays are still here, but only
  // ever as *rows to list* — never as something to add up.
  const profile = state.profile || {};
  const pos = state.pos || [];
  const invoices = state.invoices || [];
  const performance = state.performance || {};
  const summary = state.summary;

  // Issue #289. A skeleton used to be shown for a fixed 1.2 s after every
  // mount — "to demonstrate skeleton states" — and so hid rows that had
  // already arrived, and cleared itself while rows that had not were still in
  // flight. Each region below now asks about the data it is actually waiting
  // on: `summary === null` until GET /api/dashboard/summary answers,
  // `posLoaded` / `invoicesLoaded` until those first fetches settle,
  // `payments === null` until usePayments' does (#111).
  //
  // The two list flags are set on *settling*, so a failed fetch shows the
  // empty state rather than a skeleton forever. `summary` is not: a figure
  // has no honest empty state — zero is a claim — so a summary that never
  // answers keeps its skeleton, as it did before this change.
  const ordersLoading = !state.posLoaded;
  const invoicesLoading = !state.invoicesLoaded;

  // null until the summary answers. A figure is not rendered from a partial
  // stand-in while it is missing: the skeletons below cover that frame.
  const figures = summary && {
    // PO_AWAITING_SUPPLIER: orders to acknowledge or ship. This tile used to
    // read "Open orders" — and so did the Reports page's, over a wider group
    // (PO_NOT_INVOICED), so one supplier read two different "open orders"
    // numbers on two tabs (issue #288). Each is now labelled by its group.
    awaitingYou: summary.pos.awaitingSupplierCount,
    toAcknowledge: summary.pos.awaitingAcknowledgement,
    toShip: summary.pos.byStatus.Acknowledged,
    toInvoice: summary.grns.awaitingInvoice,
    unpaidCount: summary.invoices.openCount,
    // What is actually still owed: open invoices only (a rejected one is not
    // a receivable) and net of part payments — see issue #283.
    unpaidTotal: summary.invoices.openValue,
    matchWarnings: summary.invoices.matchWarningCount,
    openRfqs: summary.rfqs.openForBids,
  };

  // Sample ids for the alert lines. The counts beside them are the server's.
  const toAcknowledgeRows = pos.filter(p => p.status === 'Open');
  const toShipRows = pos.filter(p => p.status === 'Acknowledged');
  const pendingInvoiceRows = (state.grns || []).filter(g => !g.invoiceSubmitted);
  const matchWarningRows = invoices.filter(inv => inv.status === 'Match Warning');
  const openRfqRows = (state.rfqs || []).filter(rfq =>
    rfq.status === 'Bidding Open' && !(rfq.bids || []).some(bid => bid.vendorId === profile.vendorId));

  const hasPerformance = performance.weightedScore != null;

  // Pull latest POs action trigger. This used to spawn a fabricated inbound
  // order; purchase orders come from the buyer’s system, so it re-reads them instead.
  //
  // The button has its own pending flag: a control that says it is working is
  // reporting on this click, not on the page's first load.
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleFetchPOs = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        portal?.poHook?.refreshPOs?.(),
        portal?.poHook?.refreshSapPoStatus?.(),
        portal?.dashboardHook?.refreshSummary?.(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Action items, each one a count of real documents that are waiting on the
  // supplier. No alert is shown for a condition the data does not establish —
  // and none is shown before the server's counts arrive, since the count is
  // the whole content of the line.
  const alerts = [];
  if (figures?.matchWarnings > 0) {
    alerts.push({
      type: 'warning',
      title: `Invoice match warning (${listIds(matchWarningRows, inv => inv.invoiceNumber || inv.id, figures.matchWarnings)})`,
      desc: 'The buyer’s three-way match flagged a difference between the order, the goods receipt and the invoice.',
      actionText: 'Review invoices',
      tab: 'invoices',
    });
  }
  if (figures?.toAcknowledge > 0) {
    alerts.push({
      type: 'acknowledge',
      title: `${plural(figures.toAcknowledge, 'purchase order')} awaiting acknowledgement (${listIds(toAcknowledgeRows, po => po.id, figures.toAcknowledge)})`,
      desc: 'Confirm you accept the order so the buyer knows it is in hand.',
      actionText: 'Acknowledge',
      tab: 'pos',
    });
  }
  if (figures?.toInvoice > 0) {
    alerts.push({
      type: 'invoice',
      title: `${plural(figures.toInvoice, 'goods receipt')} awaiting invoice (${listIds(pendingInvoiceRows, g => g.id, figures.toInvoice)})`,
      desc: 'Submit your invoice against these goods receipts so payment can be processed.',
      actionText: 'Submit invoice',
      tab: 'pos',
    });
  }
  if (figures?.toShip > 0) {
    alerts.push({
      type: 'ship',
      title: `${plural(figures.toShip, 'acknowledged order')} ready to ship (${listIds(toShipRows, po => po.id, figures.toShip)})`,
      desc: 'Send the shipment notice when goods leave your dock, so the goods receipt can be matched.',
      actionText: 'Send shipment',
      tab: 'pos',
    });
  }
  if (figures?.openRfqs > 0) {
    alerts.push({
      type: 'rfq',
      title: `${plural(figures.openRfqs, 'RFQ')} open for your quotation (${listIds(openRfqRows, rfq => rfq.id, figures.openRfqs)})`,
      desc: `${openRfqRows[0]?.description || 'Request for quotation'}${figures.openRfqs > 1 ? ` and ${figures.openRfqs - 1} more` : ''}.`,
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
    { key: 'date', header: 'Raised', render: (row) => displayDate(row.createdDate) },
    { key: 'value', header: 'Value (₹)', align: 'right', render: (row) => <span className="mono">{formatAmount(poTotal(row))}</span> },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.status} variant={poStatusVariant(row.status)} /> },
  ];

  const invoiceColumns = [
    { key: 'no', header: 'Invoice', primary: true, render: (row) => <span className="mono">{invoiceKey(row)}</span> },
    { key: 'poId', header: 'Order', mono: true },
    { key: 'date', header: 'Date', render: (row) => displayDate(row.invoiceDate) },
    { key: 'value', header: 'Value (₹)', align: 'right', render: (row) => <span className="mono">{formatAmount(row.totalAmount)}</span> },
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
              <span className="basis-full text-fg-subtle">{displayDate(today)} · {fiscalLabel(today)}</span>
            </span>
          )}
          secondary={(
            <Button variant="secondary" onClick={handleFetchPOs} loading={isRefreshing}>
              <RefreshCw strokeWidth={1.5} /> Refresh orders
            </Button>
          )}
        />

        {/* Top band: performance as pills, the three figures that matter. */}
        <div className="mb-6 flex flex-col gap-6 xl:flex-row xl:items-end">
          <div className="min-w-0 flex-1">
            {!hasPerformance ? (
              <p className="text-sm text-fg-muted">Scores appear once you have delivered and invoiced against a purchase order.</p>
            ) : (
              // Same measures and targets as the Performance page; one the
              // API has not computed is left out, not drawn as 0%.
              <MeterPillRow
                items={MEASURES.filter((m) => performance[m.key] != null).map((m, i) => ({
                  label: `${m.name} · target ${m.target}%`,
                  value: money(performance[m.key]),
                  variant: PILL_STYLES[i % PILL_STYLES.length],
                  format: (v) => `${+v.toFixed(2)}%`,
                }))}
              />
            )}
            <Button variant="link" className="mt-2" onClick={() => setActiveTab('performance')}>Performance details</Button>
          </div>
          {!figures ? (
            <div className="w-full max-w-md"><TableSkeleton rows={1} cols={3} /></div>
          ) : (
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <KPICard
                size="hero"
                label="Awaiting you"
                value={figures.awaitingYou}
                hint={figures.toAcknowledge ? `${figures.toAcknowledge} awaiting acknowledgement` : 'All acknowledged'}
              />
              <KPICard size="hero" label="To invoice" value={figures.toInvoice} hint={figures.toInvoice ? plural(figures.toInvoice, 'goods receipt') : 'Nothing to invoice'} />
              <KPICard
                size="hero"
                label="Supplier score"
                value={hasPerformance ? <>{performance.weightedScore}<span className="ml-1 text-lg font-normal text-fg-muted">/ 100{performance.grade ? ` · ${performance.grade}` : ''}</span></> : '—'}
                empty={!hasPerformance}
                hint={hasPerformance ? undefined : 'After your first delivery'}
              />
            </div>
          )}
        </div>

        {/* Bento: pipeline · money over time · what is owed to you. */}
        <div className="mb-10 grid gap-4 lg:grid-cols-2 xl:grid-cols-[17rem_minmax(0,1fr)_19rem]">
          <Card className="p-5">
            <h2 className="mb-4 text-lg font-medium text-fg">Order pipeline</h2>
            {!figures ? (
              <TableSkeleton rows={4} cols={2} />
            ) : (
              <div className="space-y-2">
                <StatTile label="To acknowledge" count={figures.toAcknowledge} tone="info" onClick={() => setActiveTab('pos')} />
                <StatTile label="To ship" count={figures.toShip} tone="success" onClick={() => setActiveTab('pos')} />
                <StatTile label="To invoice" count={figures.toInvoice} tone="accent" onClick={() => setActiveTab('pos')} />
                <StatTile label="RFQs to quote" count={figures.openRfqs} tone="warn" onClick={() => setActiveTab('rfqs')} />
              </div>
            )}
          </Card>

          <Card className="min-w-0 p-5 lg:col-span-2 lg:row-start-2 xl:col-span-1 xl:row-start-auto">
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              <h2 className="text-lg font-medium text-fg">Invoiced and paid</h2>
              <span className="flex items-center gap-3 text-xs text-fg-muted">
                <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-[var(--chart-series)]" aria-hidden="true" />Invoiced</span>
                <span className="flex items-center gap-1.5"><span className="h-0 w-3 border-t-2 border-dashed border-[var(--chart-series-2)]" aria-hidden="true" />Paid</span>
              </span>
              <div className="ml-auto">
                <SegmentedControl
                  aria-label="Period"
                  size="sm"
                  value={flowMonths}
                  onChange={setFlowMonths}
                  options={[{ value: '12', label: '12 months' }, { value: '6', label: '6 months' }]}
                />
              </div>
            </div>
            {!summary ? (
              <TableSkeleton rows={4} cols={3} />
            ) : summary.invoices.total === 0 && summary.payments.total === 0 ? (
              <p className="py-12 text-center text-sm text-fg-muted">Your invoices and payments will chart here once you have some.</p>
            ) : (
              <SplineChart
                ariaLabel={`Invoiced and paid by month, last ${flowMonths} months`}
                data={flowRows(summary.flow, Number(flowMonths))}
                series={[{ key: 'invoiced', name: 'Invoiced' }, { key: 'paid', name: 'Paid' }]}
              />
            )}
          </Card>

          {!figures ? (
            <Card tone="accent" className="p-5" aria-busy="true"><div className="skeleton h-32 opacity-30" /></Card>
          ) : (
          <Card tone="accent" className="flex flex-col p-5">
            <h2 className="text-lg font-medium">Awaiting payment</h2>
            <p className="mono mt-3 text-[32px] leading-10 font-light tracking-[-0.02em]">{formatMoney(figures.unpaidTotal)}</p>
            <p className="mt-1 text-sm opacity-85">
              {figures.unpaidCount ? `${plural(figures.unpaidCount, 'invoice')} still open` : 'Nothing outstanding'}
            </p>
            <div className="mt-auto flex flex-wrap gap-2 pt-6">
              <button type="button" className="btn h-9! bg-[var(--accent-fg)] text-[var(--accent-solid)] hover:opacity-90" onClick={() => setActiveTab('invoices')}>
                Review invoices
              </button>
              <button type="button" className="btn h-9! border-[color-mix(in_srgb,var(--accent-fg)_40%,transparent)] text-[var(--accent-fg)] hover:bg-[color-mix(in_srgb,var(--accent-fg)_10%,transparent)]" onClick={downloadStatement}>
                <Download className="size-4" strokeWidth={1.5} /> Statement
              </button>
            </div>
          </Card>
          )}
        </div>

        <div className="grid gap-x-8 gap-y-10 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-10">
            <Section title="Needs your attention">
              {/* `!summary`, and nothing else: "Nothing needs your attention"
                  is a claim, and before the counts arrive there is nothing to
                  base it on. */}
              {!summary ? (
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
                loading={ordersLoading}
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
                loading={invoicesLoading}
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
              title="Recent payments"
              actions={<Button variant="link" onClick={() => setActiveTab('payments')}>All payments</Button>}
            >
              {/* state.payments is null until usePayments' first fetch answers
                  (issue #111) — distinct from [], a vendor confirmed to have
                  no payments. Rendering the empty state for null told a
                  supplier who simply hadn't loaded yet that they had never
                  been paid. */}
              {state.payments === null ? (
                <div className="card"><TableSkeleton rows={2} cols={2} /></div>
              ) : state.payments.length === 0 ? (
                /* No "released 45 days after approval" here any more: that
                   number came from no setting, no payment terms and no
                   endpoint — it was a constant stating a commitment on the
                   buyer's behalf (issue #289). Payment terms are agreed per
                   order (PurchaseOrder.paymentTerms) and vary, so the one
                   place to read them is the order. */
                <p className="text-sm text-fg-muted">
                  No payments yet. A payment appears here once your buyer releases one against an approved invoice; when it is due is set by the payment terms on the order.
                </p>
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
                            {paymentInvoiceLabel(row) && <><span className="mono">{paymentInvoiceLabel(row)}</span> · </>}
                            {displayDate(row.paymentDate)} · {row.paymentMethod || '—'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="mono text-fg">{formatMoney(row.netAmount)}</p>
                          {money(row.tdsDeducted) > 0 && <p className="text-xs text-fg-subtle">TDS <span className="mono">{formatMoney(row.tdsDeducted)}</span></p>}
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
        title={drawerContent ? (drawerContent.type === 'PO' ? 'Purchase order' : 'Invoice') : ''}
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
            <DocumentHero
              status={drawerContent.data.status}
              statusVariant={drawerContent.type === 'PO' ? poStatusVariant(drawerContent.data.status) : invoiceStatusVariant(drawerContent.data.status)}
              id={drawerContent.type === 'PO' ? drawerContent.data.id : (drawerContent.data.invoiceNumber || drawerContent.data.no)}
              age={displayDate(drawerContent.type === 'PO' ? drawerContent.data.createdDate : drawerContent.data.invoiceDate)}
              amount={formatMoney(drawerContent.type === 'PO' ? poTotal(drawerContent.data) : drawerContent.data.totalAmount)}
              amountLabel={`Total value · ${drawerContent.data.items?.length ?? 0} ${(drawerContent.data.items?.length ?? 0) === 1 ? 'line' : 'lines'}`}
            />

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
                      <span className="mono text-fg">{formatMoney(item.netValue ?? item.amount)}</span>
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
