'use client';

import React, { useState } from 'react';
import { Download, FileText, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/ui/StatusBadge';
import DataTable from '@/components/ui/DataTable';
import KPICard, { KPIStrip } from '@/components/ui/KPICard';
import { PageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Card';
import { DropdownMenu, Tabs } from '@/components/ui/controls';
import { BucketBar, ColumnChart, RankedBars, StepLineChart } from '@/components/ui/charts';
import { formatAmount, formatMoney } from '@/lib/money';
import { msmeStatusVariant, paymentStatusVariant } from '@/lib/statusColors';
import ErrorBoundary from '@/components/ErrorBoundary';
import { usePortal } from '@/lib/portal-context';
import { downloadFromApi } from '@/lib/download';
import { INVOICE_STATUS, isInvoiceOpen } from '@/lib/documentStatus';
import { displayDate } from '@/lib/displayDate';
import { paymentInvoiceRefs } from '@/lib/paymentInvoiceLabel';

// The supplier's reports.
//
// Every figure here is their own data: a measure the data cannot establish is
// not shown, and there is no sample figure standing in for one.
//
// The totals, the charts and the exports come from the server (issue #280).
// They used to be computed in this file from `state.pos`/`state.invoices`/
// `state.payments`, each of which holds one page of a list endpoint — so
// total order value, order value by month/material/plant, the ageing
// buckets, the TDS and GST totals, the ledger balance and every CSV export
// covered the supplier's newest twenty documents and said nothing about it.
// `state.summary` is GET /api/dashboard/summary, counted in the database;
// the exports are server endpoints that write every matching row.
//
// What is still derived here is per-row presentation for the two tables whose
// rows are documents (invoice ageing, the ledger) — and those arrays are now
// read page by page to exhaustion (lib/fetchAllPages.js), not one page deep.

const DAY_MS = 24 * 60 * 60 * 1000;
const MSME_PAYMENT_DAYS = 45;

// Amounts arrive as Decimal strings from the API.
const money = (value) => Number(value) || 0;

const percent = (numerator, denominator) =>
  denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : '—';

// `formatDate` (dd.mm.yyyy) and `monthKey` lived here for the CSV exports and
// the by-month chart. Both are the server's job now — the exports are API
// endpoints (backend/controllers/reportExport.controller.js, which keeps the
// same date format) and the chart's months arrive as 'YYYY-MM' keys — so they
// are gone rather than left dead beside the code that replaced them.
const monthLabel = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

const today = () => new Date().toISOString().slice(0, 10);

// A remittance, split into the invoices it settled (issue #282): one ledger
// credit per PaymentItem, each carrying that item's own gross and naming its
// own invoice, rather than one lumped credit per remittance that no single
// invoice's debit could be matched against.
//
// A payment with no items — nothing in the API returns one, but a fixture or
// an older row might — yields a single row with the header's totals and no
// invoice reference, so it still appears in the ledger instead of silently
// vanishing from it.
//
// The TDS export is the other per-invoice view of the same split, and it is
// deliberately NOT computed here: since #280 every export is a server
// endpoint, so that one lives in backend/controllers/report.controller.js.
const paymentLedgerRows = (payments) => payments.flatMap((payment) => {
  const items = Array.isArray(payment.items) && payment.items.length
    ? payment.items
    : [{ invoiceNumber: paymentInvoiceRefs(payment)[0], netAmount: payment.netAmount, tdsDeducted: payment.tdsDeducted }];

  return items.map((item) => ({
    date: payment.paymentDate || payment.createdDate,
    type: 'KZ (Payment)',
    doc: payment.utrCode || payment.id,
    desc: `Payment for ${item.invoiceNumber || item.invoiceId || 'invoice'}`,
    debit: 0,
    // Gross is recomputed from net + TDS rather than read from grossAmount,
    // so the credit always reconciles with the figures beside it.
    credit: money(item.netAmount) + money(item.tdsDeducted),
    status: 'Cleared',
  }));
});

export default function ReportsAnalyticsView({ state }) {
  const { addToast } = usePortal();
  const [detailTab, setDetailTab] = useState('procurement'); // 'procurement' | 'finance' | 'selfservice'

  // "Now" for invoice ageing, sampled once per mount so a render stays a
  // function of its inputs (React Compiler rejects reading the clock in render).
  const [now] = useState(() => Date.now());

  const profile = state.profile || {};
  const performance = state.performance || {};
  const invoices = state.invoices || [];
  const payments = state.payments || [];
  const summary = state.summary;

  // --- Figures (server) ------------------------------------------------------
  // null until the summary answers. Nothing on this screen falls back to
  // aggregating the arrays while it is missing: that fallback is the bug.
  const po = summary?.pos;
  const inv = summary?.invoices;
  const pmt = summary?.payments;

  const spendData = (po?.byMaterial || []).map((row) => ({
    code: row.code,
    group: row.description,
    poCount: row.poCount,
    spend: row.value,
  }));
  const plantData = (po?.byPlant || []).map((row) => ({ label: row.plant, value: row.value }));
  const byMonth = (po?.byMonth || []).map((row) => ({ label: monthLabel(row.month), value: row.value }));
  const avgAckDays = po?.avgAcknowledgementDays ?? null;
  const receivedQty = summary?.grns.receivedQuantity || 0;
  const acceptedQty = summary?.grns.acceptedQuantity || 0;

  const isMsme = Boolean(inv?.isMsme ?? profile.msmeNumber);
  const ageing = inv?.ageing;

  // --- Rows (documents) ------------------------------------------------------
  // The two tables whose rows *are* documents. `state.invoices` and
  // `state.payments` hold every page now, so these are complete lists — but
  // the figures above still come from the server, so a row and a total can
  // never be computed two different ways.
  const apAgingData = invoices.map((row) => {
    const days = row.invoiceDate ? Math.max(0, Math.floor((now - new Date(row.invoiceDate)) / DAY_MS)) : 0;
    const open = isInvoiceOpen(row.status);
    // A decided invoice is not overdue, whichever way it was decided. The
    // MSME clock used to run on a Rejected one too, because the filter was
    // `status !== 'Cleared'` (issue #283).
    let msme = 'Safe';
    if (!open) msme = row.status;
    else if (isMsme && days > MSME_PAYMENT_DAYS) msme = 'Overdue (MSME Priority!)';
    else if (isMsme && days >= 30) msme = 'Critical (45-Day Alert)';
    return {
      ref: row.invoiceNumber || row.id,
      poId: row.poId,
      rawDate: row.invoiceDate,
      invoiceStatus: row.status,
      amount: money(row.totalAmount),
      // What is still owed on it: the API carries this per invoice (#63).
      // Absent on a response that predates it, in which case the total is
      // the honest best answer for an open invoice.
      outstanding: open ? money(row.outstandingAmount ?? row.totalAmount) : 0,
      days,
      status: msme,
    };
  });

  const ledgerEvents = [
    // Rejected invoices carry no debit — they are not receivables (#283) —
    // but they stay visible as zero-effect rows rather than vanishing from a
    // ledger the supplier reconciles against their own books.
    ...invoices.map((row) => ({
      date: row.invoiceDate,
      type: 'RE (Invoice)',
      doc: row.invoiceNumber || row.id,
      desc: `Invoice against ${row.poId || 'order'}`,
      debit: row.status === INVOICE_STATUS.REJECTED ? 0 : money(row.totalAmount),
      credit: 0,
      status: row.status === INVOICE_STATUS.CLEARED ? 'Cleared' : row.status,
    })),
    // One credit row per settled invoice, not one per remittance (issue
    // #282). Naming every settled invoice in one row's description (as this
    // did) tells the supplier which invoices the money covered, but still
    // left each of those invoices' debits without a matching credit of its
    // own — the running balance came out right, but no invoice could be
    // traced to the money that cleared it. Each item carries its own gross
    // (net + TDS), so the rows still sum to the remittance.
    ...paymentLedgerRows(payments),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  const chronological = ledgerEvents.reduce((rows, event) => {
    const previous = rows.length ? rows[rows.length - 1].balance : 0;
    return [...rows, { ...event, balance: previous + event.debit - event.credit }];
  }, []);
  const ledgerData = [...chronological].reverse();

  // --- Exports ---------------------------------------------------------------
  // Server endpoints, so a file holds every matching row rather than the
  // rows this component happens to be holding (issue #280). The old
  // downloadCsv path wrote whichever page of the data was loaded under the
  // file name of a complete export.
  const exportFromApi = (path, filename) => downloadFromApi(path, filename)
    .catch((err) => addToast('error', `Could not download the export: ${err.message}`));

  const exportSpend = () => exportFromApi('/reports/exports/spend-by-material', `spend-by-material-${today()}.csv`);
  const exportAging = () => exportFromApi('/reports/exports/invoice-ageing', `invoice-ageing-${today()}.csv`);
  const exportLedger = () => exportFromApi('/reports/exports/account-ledger', `account-ledger-${today()}.csv`);
  // Issue #282's per-item TDS rows live in the endpoint now, not here — see
  // the tds export in backend/controllers/report.controller.js.
  const exportTds = () => exportFromApi('/reports/exports/tds', `tds-deducted-${today()}.csv`);

  const downloadStatement = () => downloadFromApi('/reports/statement', `account-statement-${today()}.pdf`)
    .then(() => addToast('success', 'Account statement downloaded.'))
    .catch((err) => addToast('error', `Could not download the statement: ${err.message}`));

  const exportCurrentTab = () => {
    if (detailTab === 'procurement') exportSpend();
    else if (detailTab === 'finance') exportAging();
    else exportLedger();
  };

  // --- Tables ----------------------------------------------------------------
  const materialColumns = [
    { key: 'code', header: 'Material', mono: true, primary: true },
    { key: 'group', header: 'Description', wrap: true },
    { key: 'poCount', header: 'Orders', align: 'right', mono: true },
    { key: 'spend', header: 'Order value (₹)', align: 'right', render: (r) => <span className="mono">{formatAmount(r.spend)}</span> },
  ];

  const ageingColumns = [
    { key: 'ref', header: 'Invoice', mono: true, primary: true },
    { key: 'poId', header: 'Order', render: (r) => <span className="mono">{r.poId || '—'}</span> },
    { key: 'date', header: 'Invoice date', render: (r) => displayDate(r.rawDate) },
    { key: 'invoiceStatus', header: 'Status', render: (r) => (r.invoiceStatus ? <StatusBadge label={r.invoiceStatus} /> : '—') },
    { key: 'days', header: 'Age (days)', align: 'right', mono: true },
    { key: 'amount', header: 'Amount (₹)', align: 'right', render: (r) => <span className="mono">{formatAmount(r.amount)}</span> },
    // What is still owed on it, which is not the same as the total: a
    // part-settled invoice owes its balance, and a decided one owes nothing
    // (issue #283). The buckets above are built from this, not from `amount`.
    {
      key: 'outstanding',
      header: 'Outstanding (₹)',
      align: 'right',
      render: (r) => (r.outstanding > 0 ? <span className="mono">{formatAmount(r.outstanding)}</span> : <span className="text-fg-subtle">—</span>),
    },
    {
      key: 'msme',
      header: 'MSME 45-day rule',
      render: (r) => (isMsme || r.status === 'Cleared'
        ? <StatusBadge label={r.status} variant={msmeStatusVariant(r.status)} />
        : <span className="text-fg-subtle">Not MSME-registered</span>),
    },
  ];

  const ledgerColumns = [
    { key: 'date', header: 'Date', primary: true, render: (r) => displayDate(r.date) },
    { key: 'type', header: 'Type' },
    { key: 'doc', header: 'Reference', mono: true },
    { key: 'desc', header: 'Description', wrap: true },
    { key: 'debit', header: 'Debit (₹)', align: 'right', render: (r) => (r.debit > 0 ? <span className="mono">{formatAmount(r.debit)}</span> : <span className="text-fg-subtle">—</span>) },
    { key: 'credit', header: 'Credit (₹)', align: 'right', render: (r) => (r.credit > 0 ? <span className="mono">{formatAmount(r.credit)}</span> : <span className="text-fg-subtle">—</span>) },
    { key: 'balance', header: 'Balance (₹)', align: 'right', render: (r) => <span className="mono font-medium">{formatAmount(r.balance)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge label={r.status} variant={paymentStatusVariant(r.status)} /> },
  ];

  const moreActions = [
    { label: 'Export TDS deducted (CSV)', icon: Receipt, onClick: exportTds },
    { label: 'Download account statement (PDF)', icon: FileText, onClick: downloadStatement },
  ];

  return (
    <ErrorBoundary>
      <div className="pb-16">
        <PageHeader
          title="Reports"
          description="Your orders, invoice ageing and account ledger with this buyer, calculated from your documents in the portal."
          secondary={<DropdownMenu items={moreActions} label="More exports" />}
          primary={(
            <Button variant="secondary" onClick={exportCurrentTab}>
              <Download strokeWidth={1.5} /> Export CSV
            </Button>
          )}
        />

        <Tabs
          aria-label="Report"
          value={detailTab}
          onValueChange={setDetailTab}
          items={[
            { value: 'procurement', label: 'Orders' },
            { value: 'finance', label: 'Invoices and tax' },
            { value: 'selfservice', label: 'Account ledger' },
          ]}
        />

        {detailTab === 'procurement' && (
          <div className="pt-6">
            <div className="flex flex-wrap gap-x-12 gap-y-5">
              <KPICard size="hero" label="Total order value" value={<span className="mono">{formatMoney(po?.totalValue)}</span>} empty={!po?.totalValue} />
              <KPICard size="hero" label="Purchase orders" value={po ? po.total : '—'} empty={!po} />
              <KPICard size="hero" label="Open orders" value={po ? po.inFlightCount : '—'} empty={!po} hint={po?.inFlightCount ? `${formatMoney(po.inFlightValue)} still open` : 'Nothing open'} />
              <KPICard size="hero"
                label="RFQs you quoted on"
                value={summary?.rfqs.invited ? percent(summary.rfqs.quoted, summary.rfqs.invited) : '—'}
                empty={!summary?.rfqs.invited}
                hint={summary?.rfqs.invited ? `${summary.rfqs.quoted} of ${summary.rfqs.invited} RFQs` : 'No RFQs yet'}
              />
            </div>

            <Section className="mt-8" title="Order value by month" description="By the month each order was raised.">
              <div className="card p-4">
                {!po
                  ? <p className="py-2 text-sm text-fg-muted">Loading your order history…</p>
                  : byMonth.length
                  ? <ColumnChart data={byMonth} ariaLabel={`Order value by month: ${byMonth.map((m) => `${m.label} ${formatMoney(m.value)}`).join(', ')}`} />
                  : <p className="py-2 text-sm text-fg-muted">Nothing to chart yet.</p>}
              </div>
            </Section>

            <div className="mt-8 grid gap-6 lg:grid-cols-2">
              <Section title="By material">
                <div className="card p-4">
                  {!po
                    ? <p className="py-2 text-sm text-fg-muted">Loading…</p>
                    : spendData.length
                    ? <RankedBars ariaLabel="Order value by material" data={spendData.map((r) => ({ label: r.code, title: `${r.code} — ${r.group}`, value: r.spend }))} />
                    : <p className="py-2 text-sm text-fg-muted">Nothing ordered yet.</p>}
                </div>
              </Section>
              <Section title="By plant">
                <div className="card p-4">
                  {!po
                    ? <p className="py-2 text-sm text-fg-muted">Loading…</p>
                    : plantData.length
                    ? <RankedBars ariaLabel="Order value by plant" data={plantData} />
                    : <p className="py-2 text-sm text-fg-muted">Nothing ordered yet.</p>}
                </div>
              </Section>
            </div>

            {/* "No purchase orders yet" is a claim about the account, so the
                table's empty text waits for the server to have answered. */}
            <Section className="mt-8" title="Order value by material">
              <DataTable
                caption="Order value by material"
                columns={materialColumns}
                rows={spendData}
                getRowId={(r) => r.code}
                maxHeight="420px"
                empty={po ? 'No purchase orders yet.' : 'Loading your orders…'}
                totals={spendData.length > 1 ? {
                  label: `${spendData.length} materials`,
                  spend: <span className="mono">{formatAmount(po?.totalValue)}</span>,
                } : undefined}
              />
            </Section>

            <Section className="mt-8" title="Delivery">
              <KPIStrip>
                <KPICard label="On-time in full" value={performance.deliveryOTIF == null ? '—' : `${performance.deliveryOTIF}%`} empty={performance.deliveryOTIF == null} />
                <KPICard label="Average time to acknowledge" value={avgAckDays == null ? '—' : `${avgAckDays.toFixed(1)} days`} empty={avgAckDays == null} />
                <KPICard label="Quantity accepted on receipt" value={percent(acceptedQty, receivedQty)} empty={!receivedQty} />
              </KPIStrip>
            </Section>
          </div>
        )}

        {detailTab === 'finance' && (
          <div className="pt-6">
            <Section title="Outstanding invoices by age" description="Invoices not yet cleared, by days since the invoice date.">
              <div className="card p-4">
                {/* Four zeroes read as "nothing outstanding", which is a
                    claim — so the chart waits for the server's buckets. */}
                {!ageing ? <p className="py-2 text-sm text-fg-muted">Loading your invoice ageing…</p> : (
                <BucketBar
                  ariaLabel="Outstanding invoice value by age"
                  buckets={[
                    { label: '0–30 days', value: ageing?.['0-30'] || 0 },
                    { label: '31–60 days', value: ageing?.['31-60'] || 0 },
                    { label: '61–90 days', value: ageing?.['61-90'] || 0 },
                    { label: 'Over 90 days', value: ageing?.['90+'] || 0 },
                  ]}
                />
                )}
              </div>
            </Section>

            <Section className="mt-8" title="Invoice ageing">
              <DataTable
                caption="Invoice ageing"
                columns={ageingColumns}
                rows={apAgingData}
                getRowId={(r) => r.ref}
                maxHeight="420px"
                empty="No invoices submitted yet."
              />
            </Section>

            <Section className="mt-8" title="Tax and processing">
              <KPIStrip>
                <KPICard label="TDS deducted" value={<span className="mono">{formatMoney(pmt?.tdsTotal)}</span>} empty={!pmt?.tdsTotal} hint="Across all payments" />
                <KPICard label="GST charged" value={<span className="mono">{formatMoney(inv?.taxTotal)}</span>} empty={!inv?.taxTotal} hint="On your invoices" />
                <KPICard
                  label="Paid and cleared"
                  value={inv?.total ? `${inv.clearedCount} of ${inv.total}` : '—'}
                  empty={!inv?.total}
                  hint={inv?.total ? percent(inv.clearedCount, inv.total) : 'No invoices yet'}
                />
                <KPICard
                  label="Needs attention"
                  value={inv ? inv.matchWarningCount + inv.msmeOverdueCount : '—'}
                  empty={!inv}
                  hint={inv
                    ? `${inv.matchWarningCount} match warning${inv.matchWarningCount === 1 ? '' : 's'}${isMsme ? ` · ${inv.msmeOverdueCount} MSME invoice${inv.msmeOverdueCount === 1 ? '' : 's'} over 45 days` : ''}`
                    : undefined}
                />
              </KPIStrip>
            </Section>
          </div>
        )}

        {detailTab === 'selfservice' && (
          <div className="pt-6">
            <KPIStrip>
              <KPICard label="Open order value" value={<span className="mono">{formatMoney(po?.inFlightValue)}</span>} empty={!po?.inFlightValue} />
              {/* What is still owed: open invoices, net of part payments. */}
              <KPICard label="Awaiting payment" value={<span className="mono">{formatMoney(inv?.openValue)}</span>} empty={!inv?.openValue} />
              <KPICard label="Ledger balance" value={<span className="mono">{formatMoney(summary?.ledgerBalance)}</span>} empty={!summary?.ledgerBalance} />
              <KPICard label="Supplier score" value={performance.weightedScore == null ? '—' : `${performance.weightedScore} / 100`} empty={performance.weightedScore == null} />
            </KPIStrip>

            <Section className="mt-8" title="Balance over time" description="Invoices raise the balance; payments (net plus TDS) bring it down.">
              <div className="card p-4">
                {chronological.length > 1
                  ? <StepLineChart ariaLabel="Ledger balance over time" data={chronological.map((r) => ({ label: displayDate(r.date), value: r.balance }))} />
                  : <p className="py-2 text-sm text-fg-muted">Not enough activity to chart yet.</p>}
              </div>
            </Section>

            <Section className="mt-8" title="Account ledger">
              <DataTable
                caption="Account ledger"
                columns={ledgerColumns}
                rows={ledgerData}
                getRowId={(r, i) => `${r.doc}-${i}`}
                maxHeight="480px"
                empty="No invoices or payments yet."
              />
            </Section>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
