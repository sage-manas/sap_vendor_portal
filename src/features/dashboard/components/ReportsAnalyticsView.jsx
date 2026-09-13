'use client';

import React, { useState } from 'react';
import {
  FileText, Calendar, CheckCircle2, FileSpreadsheet, Download,
  TrendingUp, ShoppingBag, Percent, Layers, Building2,
  Clock, Activity, Receipt, ShieldCheck, AlertTriangle
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/ui/StatusBadge';
import { msmeStatusVariant, paymentStatusVariant } from '@/lib/statusColors';
import ErrorBoundary from '@/components/ErrorBoundary';
import { usePortal } from '@/lib/portal-context';
import { downloadCsv, downloadFromApi } from '@/lib/download';

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

const inr = (value) =>
  `₹ ${money(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const percent = (numerator, denominator) =>
  denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : '—';

const formatDate = (dateStr) => {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${d.getFullYear()}`;
};

const today = () => new Date().toISOString().slice(0, 10);

function SapReadOnlyField({ label, value, isMonospace = true, containerClassName = '', icon: Icon }) {
  return (
    <div className="flex flex-col gap-1 items-center select-none focus-within:outline-none">
      <span className="text-[9px] font-extrabold text-text-secondary uppercase tracking-wider flex items-center gap-1 leading-none" title={label}>
        {Icon && <Icon className="size-3 text-text-tertiary shrink-0" />}
        <span>{label}</span>
      </span>
      <div
        className={`inline-flex items-center gap-1.5 border rounded-md px-2.5 text-xs h-6.5 font-semibold cursor-default box-border w-fit max-w-full overflow-hidden text-ellipsis whitespace-nowrap tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-em focus-visible:ring-offset-1 select-all transition-colors duration-150 ${isMonospace ? 'font-mono' : 'font-sans'
          } ${containerClassName || 'bg-surface2 text-text-primary border-border'}`}
        title={value == null ? '' : String(value)}
        tabIndex={0}
      >
        <span>{value == null || value === '' ? '—' : value}</span>
      </div>
    </div>
  );
}

function Section({ title, dot = 'bg-blue-500', children }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border bg-surface2/40">
        <div className={`size-1.5 rounded-full ${dot}`}></div>
        <span className="text-[10px] font-extrabold text-text-tertiary uppercase tracking-widest">{title}</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-5">{children}</div>
    </div>
  );
}

function EmptyRow({ colSpan, children }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-6 px-3 text-center text-[11px] text-text-tertiary">{children}</td>
    </tr>
  );
}

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
  const topPlant = Object.entries(plantMap).sort((a, b) => b[1] - a[1])[0];

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
    ...payments.map((pmt) => ({
      date: pmt.paymentDate || pmt.createdDate,
      type: 'KZ (Payment)',
      doc: pmt.utrCode || pmt.id,
      desc: `Payment for ${pmt.invoiceNumber || pmt.invoiceId || 'invoice'}`,
      debit: 0,
      credit: money(pmt.netAmount) + money(pmt.tdsDeducted),
      status: 'Cleared',
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  const chronological = ledgerEvents.reduce((rows, event) => {
    const previous = rows.length ? rows[rows.length - 1].balance : 0;
    return [...rows, { ...event, balance: previous + event.debit - event.credit }];
  }, []);
  const runningBalance = chronological.length ? chronological[chronological.length - 1].balance : 0;
  const ledgerData = [...chronological].reverse();
  const lastTransaction = ledgerData[0];

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

  const exportTds = () => downloadCsv(`tds-deducted-${today()}.csv`, [
    { header: 'Payment date', value: (r) => formatDate(r.paymentDate) },
    { header: 'Invoice', value: (r) => r.invoiceNumber || r.invoiceId },
    { header: 'UTR', value: (r) => r.utrCode },
    { header: 'Gross (INR)', value: (r) => money(r.grossAmount).toFixed(2) },
    { header: 'TDS (INR)', value: (r) => money(r.tdsDeducted).toFixed(2) },
    { header: 'Net (INR)', value: (r) => money(r.netAmount).toFixed(2) },
  ], payments);

  const downloadStatement = () => downloadFromApi('/reports/statement', `account-statement-${today()}.pdf`)
    .then(() => addToast('success', 'Account statement downloaded.'))
    .catch((err) => addToast('error', `Could not download the statement: ${err.message}`));

  const exportCurrentTab = () => {
    if (detailTab === 'procurement') exportSpend();
    else if (detailTab === 'finance') exportAging();
    else exportLedger();
  };

  return (
    <ErrorBoundary>
      <div className="space-y-6 max-w-full mx-auto animate-fade-in pb-16 relative">

        {/* PAGE HEADER */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4 select-none">
          <div className="space-y-1">
            <h2 className="page-title flex items-center gap-2.5">
              <FileSpreadsheet className="size-5 text-text-tertiary shrink-0" />
              <span>Reports &amp; Analytics</span>
            </h2>
            <p className="text-text-tertiary text-xs font-semibold">
              Your orders, invoice ageing and account ledger with this buyer, calculated from your documents in the portal
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              className="flex items-center gap-2 bg-surface border border-border hover:border-border-em hover:bg-surface2 text-text-secondary font-semibold px-3 h-9 rounded-md transition-all text-xs cursor-pointer shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-em"
              onClick={exportCurrentTab}
            >
              <Download className="size-4 text-text-tertiary shrink-0" />
              <span>Export CSV</span>
            </button>
          </div>
        </div>

        {/* TAB HEADERS */}
        <div className="flex items-center gap-6 border-b border-border">
          {[
            { id: 'procurement', label: '1. Orders & Spend' },
            { id: 'finance', label: '2. Invoices & Tax' },
            { id: 'selfservice', label: '3. Account Ledger' },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setDetailTab(t.id)}
              className={`pb-2.5 text-xs font-bold border-b-2 transition-all cursor-pointer ${detailTab === t.id
                  ? 'border-text-primary text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
                }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* TAB CONTENT BLOCK */}
        <div className="bg-surface2/30 p-1 rounded-xl">

          {/* TAB CONTENT: 1. ORDERS & SPEND */}
          {detailTab === 'procurement' && (
            <div className="space-y-6 animate-fade-in">
              <Section title="Order Key Performance Indicators">
                <SapReadOnlyField label="Total Order Value" value={inr(totalOrderValue)} icon={TrendingUp} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                <SapReadOnlyField label="Purchase Orders" value={String(pos.length)} icon={ShoppingBag} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                <SapReadOnlyField label="Open POs - Value" value={`${openPos.length} · ${inr(openPoValue)}`} icon={ShoppingBag} containerClassName="bg-orange-50 text-orange-700 border-orange-200" />
                <SapReadOnlyField label="RFQ Participation Rate" value={rfqs.length ? `${percent(bidOn.length, rfqs.length)} (${bidOn.length}/${rfqs.length})` : '—'} icon={Percent} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-200" />
              </Section>

              <Section title="Spend Breakdown" dot="bg-teal-500">
                <SapReadOnlyField label="Materials Supplied" value={String(spendData.length)} icon={Layers} containerClassName="bg-teal-50 text-teal-700 border-teal-200" />
                <SapReadOnlyField label="Top Material" value={spendData[0] ? `${spendData[0].code} · ${inr(spendData[0].spend)}` : '—'} icon={Layers} containerClassName="bg-teal-50 text-teal-700 border-teal-200" />
                <SapReadOnlyField label="Top Plant" value={topPlant ? `${topPlant[0]} · ${inr(topPlant[1])}` : '—'} icon={Building2} containerClassName="bg-amber-50 text-amber-700 border-amber-200" />
              </Section>

              {/* Spend Table */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                  <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                    Order Value by Material
                  </h3>
                </div>
                <div className="w-full overflow-x-auto overflow-y-auto max-h-[320px] custom-scrollbar card">
                  <table className="w-full text-left border-collapse min-w-[700px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-surface2 border-b border-border text-text-primary font-bold uppercase text-[10px] tracking-wider font-sans">
                        <th className="py-2.5 px-3 border-r border-border w-16">No</th>
                        <th className="py-2.5 px-3 border-r border-border w-44">Material Code</th>
                        <th className="py-2.5 px-3 border-r border-border min-w-[200px]">Description</th>
                        <th className="py-2.5 px-3 border-r border-border w-28 text-right">POs</th>
                        <th className="py-2.5 px-3 w-40 text-right">Order Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border text-text-secondary">
                      {spendData.length === 0 && <EmptyRow colSpan={5}>No purchase orders yet.</EmptyRow>}
                      {spendData.map((item, idx) => (
                        <tr key={item.code} className="hover:bg-surface2 transition-colors">
                          <td className="py-2 px-3 border-r border-border text-text-secondary font-semibold font-mono tabular-nums">{idx + 1}</td>
                          <td className="py-2 px-3 border-r border-border font-mono font-bold text-text-primary">{item.code}</td>
                          <td className="py-2 px-3 border-r border-border font-sans font-medium text-text-primary">{item.group}</td>
                          <td className="py-2 px-3 border-r border-border text-right font-mono tabular-nums">{item.poCount}</td>
                          <td className="py-2 px-3 text-right font-mono font-bold text-text-primary tabular-nums">{inr(item.spend)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <Section title="Delivery Metrics" dot="bg-emerald-500">
                <SapReadOnlyField label="On-Time In-Full (OTIF)" value={performance.deliveryOTIF == null ? '—' : `${performance.deliveryOTIF}%`} icon={CheckCircle2} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-200" />
                <SapReadOnlyField label="Avg PO Acknowledgement" value={avgAckDays == null ? '—' : `${avgAckDays.toFixed(1)} days`} icon={Clock} containerClassName="bg-amber-50 text-amber-700 border-amber-200" />
                <SapReadOnlyField label="Quantity Accepted on Receipt" value={percent(acceptedQty, receivedQty)} icon={Percent} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-200" />
              </Section>

              <div className="flex justify-end items-center card p-4 w-full">
                <Button onClick={exportSpend} variant="outline" className="font-bold text-xs px-5 h-9">
                  Export Order Value (CSV)
                </Button>
              </div>
            </div>
          )}

          {/* TAB CONTENT: 2. INVOICES & TAX */}
          {detailTab === 'finance' && (
            <div className="space-y-6 animate-fade-in">
              <Section title="Outstanding Invoices by Age">
                <SapReadOnlyField label="0-30 Days" value={inr(bucket(0, 30))} icon={Clock} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                <SapReadOnlyField label="31-60 Days" value={inr(bucket(31, 60))} icon={Clock} containerClassName="bg-orange-50 text-orange-700 border-orange-200" />
                <SapReadOnlyField label="61-90 Days" value={inr(bucket(61, 90))} icon={Clock} containerClassName="bg-surface2 text-text-secondary border-border" />
                <SapReadOnlyField label="Over 90 Days" value={inr(bucket(91))} icon={AlertTriangle} containerClassName="bg-rose-50 text-rose-800 border-rose-200" />
              </Section>

              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                  <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                    Invoice Ageing Details
                  </h3>
                </div>
                <div className="w-full overflow-x-auto overflow-y-auto max-h-[320px] custom-scrollbar card">
                  <table className="w-full text-left border-collapse min-w-[800px] whitespace-nowrap">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-surface2 border-b border-border text-text-primary font-bold uppercase text-[10px] tracking-wider font-sans">
                        <th className="py-2.5 px-3 border-r border-border w-40">Invoice Ref</th>
                        <th className="py-2.5 px-3 border-r border-border w-32">Purchase Order</th>
                        <th className="py-2.5 px-3 border-r border-border w-24 text-center">Date</th>
                        <th className="py-2.5 px-3 border-r border-border w-32">Invoice Status</th>
                        <th className="py-2.5 px-3 border-r border-border w-24 text-right">Age (Days)</th>
                        <th className="py-2.5 px-3 border-r border-border w-36 text-right">Amount</th>
                        <th className="py-2.5 px-3 text-center w-40">MSME 45-Day Rule</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border text-text-secondary">
                      {apAgingData.length === 0 && <EmptyRow colSpan={7}>No invoices submitted yet.</EmptyRow>}
                      {apAgingData.map((item) => {
                        const isOverdue = item.status === 'Overdue (MSME Priority!)';
                        return (
                          <tr key={item.ref} className={`hover:bg-surface2 transition-colors ${isOverdue ? 'bg-rose-50/20' : ''}`}>
                            <td className="py-2 px-3 border-r border-border font-mono font-bold text-text-primary">{item.ref}</td>
                            <td className="py-2 px-3 border-r border-border font-mono">{item.poId || '—'}</td>
                            <td className="py-2 px-3 border-r border-border text-center font-mono tabular-nums">{item.date}</td>
                            <td className="py-2 px-3 border-r border-border font-semibold">{item.invoiceStatus}</td>
                            <td className={`py-2 px-3 border-r border-border text-right font-mono font-bold tabular-nums ${isOverdue ? 'text-rose-600' : ''}`}>{item.days}</td>
                            <td className="py-2 px-3 border-r border-border text-right font-mono font-bold text-text-primary tabular-nums">{inr(item.amount)}</td>
                            <td className="py-2 px-3 text-center">
                              {isMsme || item.status === 'Cleared'
                                ? <StatusBadge label={item.status} variant={msmeStatusVariant(item.status)} />
                                : <span className="text-[10px] text-text-tertiary">Not MSME-registered</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <Section title="Tax Withheld & GST" dot="bg-emerald-500">
                <SapReadOnlyField label="TDS Deducted (All Payments)" value={inr(totalTds)} icon={Receipt} containerClassName="bg-rose-50 text-rose-800 border-rose-200" />
                <SapReadOnlyField label="GST Charged on Invoices" value={inr(gstInvoiced)} icon={ShieldCheck} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-200" />
                <SapReadOnlyField label="MSME Invoices > 45 Days" value={isMsme ? String(msmeOverdue.length) : 'Not MSME-registered'} isMonospace={isMsme} icon={CheckCircle2} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-300" />
              </Section>

              <Section title="Invoice Processing" dot="bg-teal-500">
                <SapReadOnlyField label="Invoices Submitted" value={String(invoices.length)} icon={FileText} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                <SapReadOnlyField label="Paid & Cleared" value={invoices.length ? `${clearedInvoices.length} (${percent(clearedInvoices.length, invoices.length)})` : '—'} icon={Percent} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-200" />
                <SapReadOnlyField label="Match Warnings" value={String(matchWarnings.length)} icon={AlertTriangle} containerClassName="bg-rose-50 text-rose-800 border-rose-200" />
              </Section>

              <div className="flex justify-end gap-2 items-center card p-4 w-full">
                <Button onClick={exportAging} variant="outline" className="font-bold text-xs px-5 h-9">
                  Export Invoice Ageing (CSV)
                </Button>
                <Button onClick={exportTds} className="font-bold text-xs px-6 h-9">
                  Export TDS Deducted (CSV)
                </Button>
              </div>
            </div>
          )}

          {/* TAB CONTENT: 3. ACCOUNT LEDGER */}
          {detailTab === 'selfservice' && (
            <div className="space-y-6 animate-fade-in">
              <Section title="Account Snapshot">
                <SapReadOnlyField label="Open POs Value" value={inr(openPoValue)} icon={ShoppingBag} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                <SapReadOnlyField label="Invoices Awaiting Payment" value={inr(outstanding.reduce((sum, row) => sum + row.amount, 0))} icon={Receipt} containerClassName="bg-orange-50 text-orange-700 border-orange-200" />
                <SapReadOnlyField label="Ledger Balance" value={inr(runningBalance)} icon={TrendingUp} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                <SapReadOnlyField label="Performance Score" value={performance.weightedScore == null ? '—' : `${performance.weightedScore} / 100`} icon={Activity} containerClassName="bg-emerald-50 text-emerald-800 border-emerald-200" />
              </Section>

              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-2">
                  <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                    Account Ledger Statement
                  </h3>
                </div>
                <div className="w-full overflow-x-auto overflow-y-auto max-h-[320px] custom-scrollbar card">
                  <table className="w-full text-left border-collapse min-w-[850px] whitespace-nowrap">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-surface2 border-b border-border text-text-primary font-bold uppercase text-[10px] tracking-wider font-sans">
                        <th className="py-2.5 px-3 border-r border-border w-24 text-center">Date</th>
                        <th className="py-2.5 px-3 border-r border-border w-28">Doc Type</th>
                        <th className="py-2.5 px-3 border-r border-border w-40">Document Ref</th>
                        <th className="py-2.5 px-3 border-r border-border min-w-[200px]">Description</th>
                        <th className="py-2.5 px-3 border-r border-border w-32 text-right">Debit (₹)</th>
                        <th className="py-2.5 px-3 border-r border-border w-32 text-right">Credit (₹)</th>
                        <th className="py-2.5 px-3 border-r border-border w-36 text-right">Balance</th>
                        <th className="py-2.5 px-3 text-center w-28">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border text-text-secondary">
                      {ledgerData.length === 0 && <EmptyRow colSpan={8}>No invoices or payments yet.</EmptyRow>}
                      {ledgerData.map((item, idx) => (
                        <tr key={`${item.doc}-${idx}`} className="hover:bg-surface2 transition-colors">
                          <td className="py-2 px-3 border-r border-border text-center font-mono font-medium tabular-nums">{formatDate(item.date)}</td>
                          <td className="py-2 px-3 border-r border-border font-medium font-sans text-text-secondary">{item.type}</td>
                          <td className="py-2 px-3 border-r border-border font-mono font-bold text-text-primary">{item.doc}</td>
                          <td className="py-2 px-3 border-r border-border font-medium">{item.desc}</td>
                          <td className="py-2 px-3 border-r border-border text-right font-mono tabular-nums">{item.debit > 0 ? inr(item.debit) : '—'}</td>
                          <td className="py-2 px-3 border-r border-border text-right font-mono tabular-nums">{item.credit > 0 ? inr(item.credit) : '—'}</td>
                          <td className="py-2 px-3 border-r border-border text-right font-mono font-bold text-text-primary tabular-nums">{inr(item.balance)}</td>
                          <td className="py-2 px-3 text-center">
                            <StatusBadge label={item.status} variant={paymentStatusVariant(item.status)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {lastTransaction && (
                <Section title="Last Transaction" dot="bg-emerald-500">
                  <SapReadOnlyField label="Document Date" value={formatDate(lastTransaction.date)} icon={Calendar} containerClassName="bg-surface2 text-text-secondary border-border" />
                  <SapReadOnlyField label="Invoice / Payment Ref" value={lastTransaction.doc} icon={FileText} containerClassName="bg-blue-50 text-blue-700 border-blue-200" />
                  <SapReadOnlyField label="Clearing Status" value={lastTransaction.status} isMonospace={false} icon={Clock} containerClassName="bg-amber-50 text-amber-700 border-amber-300" />
                </Section>
              )}

              <div className="flex justify-end gap-2 items-center card p-4 w-full">
                <Button onClick={exportLedger} variant="outline" className="font-bold text-xs px-5 h-9">
                  Export Ledger (CSV)
                </Button>
                <Button onClick={downloadStatement} className="font-bold text-xs px-6 h-9">
                  Download Statement (PDF)
                </Button>
              </div>
            </div>
          )}

        </div>
      </div>
    </ErrorBoundary>
  );
}
