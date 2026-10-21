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
import { BucketBar, ColumnChart, RankedBars, StepLineChart, inrFull } from '@/components/ui/charts';
import { msmeStatusVariant, paymentStatusVariant } from '@/lib/statusColors';
import ErrorBoundary from '@/components/ErrorBoundary';
import { usePortal } from '@/lib/portal-context';
import { downloadCsv, downloadFromApi } from '@/lib/download';
import { displayDate } from '@/lib/displayDate';
import { paymentInvoiceRefs } from '@/lib/paymentInvoiceLabel';

// The supplier's reports, computed from their own documents.
//
// Every figure on this screen is derived from the POs, goods receipts,
// invoices, payments and RFQs the portal already holds for this supplier. A
// measure the data cannot establish is not shown — there is no sample figure
// standing in for it — and every export writes the rows on screen.

const DAY_MS = 24 * 60 * 60 * 1000;
const MSME_PAYMENT_DAYS = 45;

// Amounts arrive as Decimal strings from the API.
const money = (value) => Number(value) || 0;

// Exact figure without the currency sign — tables carry ₹ in the header.
const amount = (value) =>
  money(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const percent = (numerator, denominator) =>
  denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : '—';

// dd.mm.yyyy — the CSV exports keep the format they always had.
const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
};


const monthKey = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (key) => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

const today = () => new Date().toISOString().slice(0, 10);

// A remittance, split into the invoices it settled (issue #282). Both the
// ledger and the TDS export are per-invoice views, so both read a payment
// through this: one entry per PaymentItem, each carrying that item's own
// gross/TDS/net, and the invoice it belongs to named rather than described
// as "invoice".
//
// A payment with no items — nothing in the API returns one, but a fixture or
// an older row might — yields a single entry with the header's totals and no
// invoice reference, so it still appears in the ledger and the export
// instead of silently vanishing from either.
const paymentSettlements = (payment) => {
  const items = Array.isArray(payment.items) ? payment.items : [];
  if (!items.length) {
    return [{
      payment,
      ref: paymentInvoiceRefs(payment)[0] || null,
      gross: money(payment.netAmount) + money(payment.tdsDeducted),
      tds: money(payment.tdsDeducted),
      net: money(payment.netAmount),
    }];
  }
  return items.map((item) => ({
    payment,
    ref: item.invoiceNumber || item.invoiceId || null,
    // Item gross is recomputed from net + TDS rather than read from
    // grossAmount, so a row's three figures always reconcile with each other
    // the way the ledger's credit column assumes they do.
    gross: money(item.netAmount) + money(item.tdsDeducted),
    tds: money(item.tdsDeducted),
    net: money(item.netAmount),
  }));
};

const paymentLedgerRows = (payments) => payments.flatMap((pmt) =>
  paymentSettlements(pmt).map((settlement) => ({
    date: pmt.paymentDate || pmt.createdDate,
    type: 'KZ (Payment)',
    doc: pmt.utrCode || pmt.id,
    desc: `Payment for ${settlement.ref || 'invoice'}`,
    debit: 0,
    credit: settlement.gross,
    status: 'Cleared',
  })));

const tdsExportRows = (payments) => payments.flatMap((pmt) =>
  paymentSettlements(pmt).map((settlement) => ({
    paymentDate: pmt.paymentDate,
    invoiceRef: settlement.ref,
    utrCode: pmt.utrCode,
    gross: settlement.gross,
    tds: settlement.tds,
    net: settlement.net,
  })));

export default function ReportsAnalyticsView({ state }) {
  const { addToast } = usePortal();
  const [detailTab, setDetailTab] = useState('procurement'); // 'procurement' | 'finance' | 'selfservice'

  // "Now" for invoice ageing, sampled once per mount so a render stays a
  // function of its inputs (React Compiler rejects reading the clock in render).
  const [now] = useState(() => Date.now());

  const profile = state.profile || {};
  const performance = state.performance || {};
  const pos = (state.pos || []).filter((po) => po.status !== 'Cancelled');
  const invoices = state.invoices || [];
  const payments = state.payments || [];
  const grns = state.grns || [];
  const rfqs = state.rfqs || [];

  const poValue = (po) => (po.items || []).reduce((sum, item) => sum + money(item.netValue), 0);

  // --- Procurement -----------------------------------------------------------
  const totalOrderValue = pos.reduce((sum, po) => sum + poValue(po), 0);
  const openPos = pos.filter((po) => ['Open', 'Acknowledged', 'Dispatched', 'Delivered'].includes(po.status));
  const openPoValue = openPos.reduce((sum, po) => sum + poValue(po), 0);

  const bidOn = rfqs.filter((rfq) => (rfq.bids || []).some((bid) => bid.vendorId === profile.vendorId));

  const spendMap = {};
  const plantMap = {};
  pos.forEach((po) => {
    (po.items || []).forEach((item) => {
      const code = item.materialCode || '—';
      if (!spendMap[code]) spendMap[code] = { code, group: item.description || '—', poIds: new Set(), spend: 0 };
      spendMap[code].poIds.add(po.id);
      spendMap[code].spend += money(item.netValue);
      const plant = item.plant || po.plant || '—';
      plantMap[plant] = (plantMap[plant] || 0) + money(item.netValue);
    });
  });
  const spendData = Object.values(spendMap)
    .map((row) => ({ ...row, poCount: row.poIds.size }))
    .sort((a, b) => b.spend - a.spend);
  const plantData = Object.entries(plantMap)
    .map(([plant, value]) => ({ label: plant, value }))
    .sort((a, b) => b.value - a.value);

  // Order value by the month each order was raised.
  const monthMap = {};
  pos.forEach((po) => {
    const key = monthKey(po.createdDate);
    if (key) monthMap[key] = (monthMap[key] || 0) + poValue(po);
  });
  // Every month from the first order to the last, including quiet ones — a
  // time axis that skips empty months hides exactly the gap worth seeing.
  const monthKeys = Object.keys(monthMap).sort();
  const allMonths = [];
  if (monthKeys.length) {
    const last = monthKeys[monthKeys.length - 1];
    const cursor = new Date(`${monthKeys[0]}-01T00:00:00`);
    while (monthKey(cursor) <= last) {
      allMonths.push(monthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  const byMonth = allMonths.map((key) => ({ label: monthLabel(key), value: monthMap[key] || 0 }));

  const acknowledged = pos.filter((po) => po.acknowledgedAt && po.createdDate);
  const avgAckDays = acknowledged.length
    ? (acknowledged.reduce((sum, po) => sum + (new Date(po.acknowledgedAt) - new Date(po.createdDate)), 0) / acknowledged.length / DAY_MS)
    : null;

  const grnItems = grns.flatMap((grn) => grn.items || []);
  const receivedQty = grnItems.reduce((sum, item) => sum + money(item.receivedQuantity), 0);
  const acceptedQty = grnItems.reduce((sum, item) => sum + money(item.acceptedQuantity), 0);

  // --- Finance ---------------------------------------------------------------
  const isMsme = Boolean(profile.msmeNumber);
  const apAgingData = invoices.map((inv) => {
    const days = inv.invoiceDate ? Math.max(0, Math.floor((now - new Date(inv.invoiceDate)) / DAY_MS)) : 0;
    let status = 'Safe';
    if (inv.status === 'Cleared') status = 'Cleared';
    else if (isMsme && days > MSME_PAYMENT_DAYS) status = 'Overdue (MSME Priority!)';
    else if (isMsme && days >= 30) status = 'Critical (45-Day Alert)';
    return {
      ref: inv.invoiceNumber || inv.id,
      poId: inv.poId,
      date: formatDate(inv.invoiceDate),
      rawDate: inv.invoiceDate,
      invoiceStatus: inv.status,
      amount: money(inv.totalAmount),
      days,
      status,
    };
  });
  const outstanding = apAgingData.filter((row) => row.invoiceStatus !== 'Cleared');
  const bucket = (from, to) => outstanding
    .filter((row) => row.days >= from && (to == null || row.days <= to))
    .reduce((sum, row) => sum + row.amount, 0);
  const msmeOverdue = outstanding.filter((row) => row.status === 'Overdue (MSME Priority!)');

  const totalTds = payments.reduce((sum, p) => sum + money(p.tdsDeducted), 0);
  const gstInvoiced = invoices.reduce((sum, inv) => sum + money(inv.taxAmount), 0);
  const clearedInvoices = invoices.filter((inv) => inv.status === 'Cleared');
  const matchWarnings = invoices.filter((inv) => inv.status === 'Match Warning');

  // --- Ledger ----------------------------------------------------------------
  const ledgerEvents = [
    ...invoices.map((inv) => ({
      date: inv.invoiceDate,
      type: 'RE (Invoice)',
      doc: inv.invoiceNumber || inv.id,
      desc: `Invoice against ${inv.poId || 'order'}`,
      debit: money(inv.totalAmount),
      credit: 0,
      status: inv.status === 'Cleared' ? 'Cleared' : 'Uncleared',
    })),
    // One credit row per settled invoice, not one per remittance (issue
    // #282). An F110 run clears several invoices under one payment, and a
    // single lumped credit left each of those invoices' debits without a
    // matching credit of its own — the running balance came out right, but
    // no invoice could be traced to the money that cleared it. Each item
    // carries its own gross (net + TDS), so the rows still sum to the
    // remittance.
    ...paymentLedgerRows(payments),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  const chronological = ledgerEvents.reduce((rows, event) => {
    const previous = rows.length ? rows[rows.length - 1].balance : 0;
    return [...rows, { ...event, balance: previous + event.debit - event.credit }];
  }, []);
  const runningBalance = chronological.length ? chronological[chronological.length - 1].balance : 0;
  const ledgerData = [...chronological].reverse();

  // --- Exports ---------------------------------------------------------------
  const exportSpend = () => downloadCsv(`spend-by-material-${today()}.csv`, [
    { header: 'Material', value: (r) => r.code },
    { header: 'Description', value: (r) => r.group },
    { header: 'Purchase orders', value: (r) => r.poCount },
    { header: 'Order value (INR)', value: (r) => r.spend.toFixed(2) },
  ], spendData);

  const exportAging = () => downloadCsv(`invoice-ageing-${today()}.csv`, [
    { header: 'Invoice', value: (r) => r.ref },
    { header: 'Purchase order', value: (r) => r.poId },
    { header: 'Invoice date', value: (r) => r.date },
    { header: 'Status', value: (r) => r.invoiceStatus },
    { header: 'Age (days)', value: (r) => r.days },
    { header: 'Amount (INR)', value: (r) => r.amount.toFixed(2) },
  ], apAgingData);

  const exportLedger = () => downloadCsv(`account-ledger-${today()}.csv`, [
    { header: 'Date', value: (r) => formatDate(r.date) },
    { header: 'Type', value: (r) => r.type },
    { header: 'Reference', value: (r) => r.doc },
    { header: 'Description', value: (r) => r.desc },
    { header: 'Debit (INR)', value: (r) => r.debit.toFixed(2) },
    { header: 'Credit (INR)', value: (r) => r.credit.toFixed(2) },
    { header: 'Balance (INR)', value: (r) => r.balance.toFixed(2) },
  ], ledgerData);

  // One row per settled invoice (issue #282): a remittance covering several
  // invoices used to export as one row with a blank Invoice column, which is
  // unusable for reconciling a deduction against the invoice it came off.
  const exportTds = () => downloadCsv(`tds-deducted-${today()}.csv`, [
    { header: 'Payment date', value: (r) => formatDate(r.paymentDate) },
    { header: 'Invoice', value: (r) => r.invoiceRef || '' },
    { header: 'UTR', value: (r) => r.utrCode },
    { header: 'Gross (INR)', value: (r) => r.gross.toFixed(2) },
    { header: 'TDS (INR)', value: (r) => r.tds.toFixed(2) },
    { header: 'Net (INR)', value: (r) => r.net.toFixed(2) },
  ], tdsExportRows(payments));

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
    { key: 'spend', header: 'Order value (₹)', align: 'right', render: (r) => <span className="mono">{amount(r.spend)}</span> },
  ];

  const ageingColumns = [
    { key: 'ref', header: 'Invoice', mono: true, primary: true },
    { key: 'poId', header: 'Order', render: (r) => <span className="mono">{r.poId || '—'}</span> },
    { key: 'date', header: 'Invoice date', render: (r) => displayDate(r.rawDate) },
    { key: 'invoiceStatus', header: 'Status', render: (r) => (r.invoiceStatus ? <StatusBadge label={r.invoiceStatus} /> : '—') },
    { key: 'days', header: 'Age (days)', align: 'right', mono: true },
    { key: 'amount', header: 'Amount (₹)', align: 'right', render: (r) => <span className="mono">{amount(r.amount)}</span> },
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
    { key: 'debit', header: 'Debit (₹)', align: 'right', render: (r) => (r.debit > 0 ? <span className="mono">{amount(r.debit)}</span> : <span className="text-fg-subtle">—</span>) },
    { key: 'credit', header: 'Credit (₹)', align: 'right', render: (r) => (r.credit > 0 ? <span className="mono">{amount(r.credit)}</span> : <span className="text-fg-subtle">—</span>) },
    { key: 'balance', header: 'Balance (₹)', align: 'right', render: (r) => <span className="mono font-medium">{amount(r.balance)}</span> },
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
              <KPICard size="hero" label="Total order value" value={<span className="mono">{inrFull(totalOrderValue)}</span>} empty={!totalOrderValue} />
              <KPICard size="hero" label="Purchase orders" value={pos.length} />
              <KPICard size="hero" label="Open orders" value={openPos.length} hint={openPos.length ? `${inrFull(openPoValue)} still open` : 'Nothing open'} />
              <KPICard size="hero"
                label="RFQs you quoted on"
                value={rfqs.length ? percent(bidOn.length, rfqs.length) : '—'}
                empty={!rfqs.length}
                hint={rfqs.length ? `${bidOn.length} of ${rfqs.length} RFQs` : 'No RFQs yet'}
              />
            </div>

            <Section className="mt-8" title="Order value by month" description="By the month each order was raised.">
              <div className="card p-4">
                {byMonth.length
                  ? <ColumnChart data={byMonth} ariaLabel={`Order value by month: ${byMonth.map((m) => `${m.label} ${inrFull(m.value)}`).join(', ')}`} />
                  : <p className="py-2 text-sm text-fg-muted">Nothing to chart yet.</p>}
              </div>
            </Section>

            <div className="mt-8 grid gap-6 lg:grid-cols-2">
              <Section title="By material">
                <div className="card p-4">
                  {spendData.length
                    ? <RankedBars ariaLabel="Order value by material" data={spendData.map((r) => ({ label: r.code, title: `${r.code} — ${r.group}`, value: r.spend }))} />
                    : <p className="py-2 text-sm text-fg-muted">Nothing ordered yet.</p>}
                </div>
              </Section>
              <Section title="By plant">
                <div className="card p-4">
                  {plantData.length
                    ? <RankedBars ariaLabel="Order value by plant" data={plantData} />
                    : <p className="py-2 text-sm text-fg-muted">Nothing ordered yet.</p>}
                </div>
              </Section>
            </div>

            <Section className="mt-8" title="Order value by material">
              <DataTable
                caption="Order value by material"
                columns={materialColumns}
                rows={spendData}
                getRowId={(r) => r.code}
                maxHeight="420px"
                empty="No purchase orders yet."
                totals={spendData.length > 1 ? {
                  label: `${spendData.length} materials`,
                  spend: <span className="mono">{amount(totalOrderValue)}</span>,
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
                <BucketBar
                  ariaLabel="Outstanding invoice value by age"
                  buckets={[
                    { label: '0–30 days', value: bucket(0, 30) },
                    { label: '31–60 days', value: bucket(31, 60) },
                    { label: '61–90 days', value: bucket(61, 90) },
                    { label: 'Over 90 days', value: bucket(91) },
                  ]}
                />
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
                <KPICard label="TDS deducted" value={<span className="mono">{inrFull(totalTds)}</span>} empty={!totalTds} hint="Across all payments" />
                <KPICard label="GST charged" value={<span className="mono">{inrFull(gstInvoiced)}</span>} empty={!gstInvoiced} hint="On your invoices" />
                <KPICard
                  label="Paid and cleared"
                  value={invoices.length ? `${clearedInvoices.length} of ${invoices.length}` : '—'}
                  empty={!invoices.length}
                  hint={invoices.length ? percent(clearedInvoices.length, invoices.length) : 'No invoices yet'}
                />
                <KPICard
                  label="Needs attention"
                  value={matchWarnings.length + msmeOverdue.length}
                  hint={`${matchWarnings.length} match warning${matchWarnings.length === 1 ? '' : 's'}${isMsme ? ` · ${msmeOverdue.length} MSME invoice${msmeOverdue.length === 1 ? '' : 's'} over 45 days` : ''}`}
                />
              </KPIStrip>
            </Section>
          </div>
        )}

        {detailTab === 'selfservice' && (
          <div className="pt-6">
            <KPIStrip>
              <KPICard label="Open order value" value={<span className="mono">{inrFull(openPoValue)}</span>} empty={!openPoValue} />
              <KPICard label="Awaiting payment" value={<span className="mono">{inrFull(outstanding.reduce((sum, row) => sum + row.amount, 0))}</span>} empty={!outstanding.length} />
              <KPICard label="Ledger balance" value={<span className="mono">{inrFull(runningBalance)}</span>} empty={!runningBalance} />
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
