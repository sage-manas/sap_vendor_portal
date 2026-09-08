'use client';

import React, { useState, useEffect } from 'react';
import {
  FileText, Landmark, Clock, CheckCircle2, ChevronRight, AlertCircle,
  Calendar, Building2, ShieldCheck, ShieldAlert, Receipt, Download, Search, ChevronLeft, Loader2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import ErrorBoundary from '@/components/ErrorBoundary';
import TableSkeleton from '@/components/ui/TableSkeleton';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import { paymentStatusVariant } from '@/lib/statusColors';
import { usePortal } from '@/lib/portal-context';

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  if (typeof dateStr === 'string' && dateStr.includes('T')) {
    dateStr = dateStr.split('T')[0];
  }
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
};

// --- SHARED LAYOUT COMPONENTS FROM REGISTRATION VIEW ---

function SectionHeader({ title, icon: Icon }) {
  return (
    <div className="col-span-full mb-1 mt-4 first:mt-0 select-none">
      <h3 className="text-xs font-bold text-text-primary tracking-wider uppercase border-b-2 border-primary/30 pb-1.5 flex items-center gap-2">
        {Icon && <Icon className="size-4 text-primary shrink-0" />}
        <span>{title}</span>
      </h3>
    </div>
  );
}

function SapReadOnlyField({ label, value, isFile, isMonospace = true }) {
  return (
    <div className="flex items-center text-xs select-none min-h-[28px] focus-within:outline-none">
      <span className="w-40 shrink-0 font-bold text-text-secondary text-right text-[9.5px] uppercase tracking-wide pr-2 select-none">
        {label}
      </span>
      <div
        className={`inline-flex items-center gap-1.5 bg-surface2 text-text-primary border border-border rounded-[3px] px-2.5 text-xs h-6 font-semibold cursor-default box-border w-fit max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-1 tabular-nums ${
          isMonospace ? 'font-mono' : 'font-sans'
        }`}
        title={value || ''}
        tabIndex={0}
      >
        {isFile && <FileText className="size-3.5 text-text-tertiary shrink-0" />}
        <span>{value || '—'}</span>
      </div>
    </div>
  );
}

export default function PaymentTrackingView({ state }) {
  const portal = usePortal();
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  const [detailTab, setDetailTab] = useState('status'); // 'status' | 'tds'

  // Filter and Search States
  const [searchQuery, setSearchQuery] = useState('');
  const [fromDateFilter, setFromDateFilter] = useState('');
  const [toDateFilter, setToDateFilter] = useState('');
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('all');

  // TDS Certificates Filter and Search States
  const [tdsYearFilter, setTdsYearFilter] = useState('all');
  const [tdsQuarterFilter, setTdsQuarterFilter] = useState('all');

  // SAP's own payment ledger for this vendor (GET /api/payments/sap-status).
  // null while the read is still in flight; an empty array means SAP genuinely
  // has nothing. Our rows stay the ones on screen — this is the cross-check
  // column beside them, the same arrangement the invoice registry uses.
  const sapPayments = state?.sapPayments;

  // A payment is "in SAP" if SAP's ledger holds a row for the same MIRO
  // document, the same clearing document, or the same UTR. Three keys rather
  // than one because which of them is populated depends on how far through the
  // F110 cycle the document is.
  const sapPaymentKeys = new Set(
    (sapPayments || []).flatMap((row) => [row.miroDoc, row.clearingDocument, row.utrReference].filter(Boolean))
  );
  const isConfirmedBySap = (payment) =>
    [payment.sapMiroDoc, payment.sapPaymentDoc, payment.utrCode].some((key) => key && sapPaymentKeys.has(key));

  // Real rows only. This used to merge in a hardcoded ₹42,570 payment with a
  // fabricated UTR "to guarantee rich dummy data is always visible for
  // testing" — fine in development, not something to show a supplier.
  const cleanPayments = state?.payments || [];

  const selectedPayment = cleanPayments[0];
  const paymentAmount = selectedPayment
    ? (selectedPayment.amount !== undefined ? selectedPayment.amount : (selectedPayment.netAmount || 0))
    : 0;

  // The invoice this payment settled, or null. It used to synthesise one when
  // no match was found — inventing a SAP MIRO number as "510560" + the last
  // four digits of the payment id, plus a back-computed 18% tax split. A
  // number shaped exactly like SAP's own is the worst kind of placeholder, so
  // an unmatched payment now simply has no invoice and the fields render as
  // dashes.
  const getInvoiceForPayment = (payment) => {
    if (!payment) return null;
    return (state?.invoices || []).find(
      (i) => i.id === payment.invoiceId || i.invoiceNumber === payment.invoiceId,
    ) || null;
  };
  // Amounts come off the payment SAP reported. Only the gross falls back, and
  // only arithmetically — net plus the TDS actually deducted, never a guessed
  // rate applied to a number nobody supplied.
  const tdsAmount = Number(selectedPayment?.tdsDeducted) || 0;
  const grossAmount = selectedPayment
    ? (selectedPayment.grossAmount !== undefined ? selectedPayment.grossAmount : paymentAmount + tdsAmount)
    : 0;
  const deductorTan = state?.profile?.tanNo || 'MUMB12345A';
  const deducteePan = state?.profile?.panNo || 'ABCDE1234F';

  // TDS deducted per fiscal quarter, from the payments this portal has actually
  // recorded (GET /payments/tds-summary). This is deliberately NOT a Form 16A:
  // that is a statutory certificate the buyer issues from TRACES after filing
  // its quarterly Form 26Q return, and nothing here knows whether that was
  // filed. This screen used to render five hardcoded quarters — invented
  // amounts and reference numbers, badged "Filed & Signed" — against the
  // supplier's real PAN.
  const tdsSummary = state?.tdsSummary;
  const tdsQuarters = tdsSummary?.quarters || [];
  const tdsLoading = tdsSummary === null || tdsSummary === undefined;

  // Offered from the data rather than hardcoded, so the filter cannot list a
  // year the supplier has no deductions in.
  const tdsYears = [...new Set(tdsQuarters.map((row) => row.fiscalYearLabel))];

  // Sync TDS page to 1 when TDS filters change (no-op retained for filter reset)

  // Filter TDS Certificates
  const filteredTds = tdsQuarters.filter(row => {
    const matchesYear = tdsYearFilter === 'all' || row.fiscalYearLabel === tdsYearFilter;
    const matchesQuarter = tdsQuarterFilter === 'all' || row.quarter === tdsQuarterFilter;
    return matchesYear && matchesQuarter;
  });

  // All filtered TDS — shown in scrollable container
  const allTds = filteredTds;


  // Filter payments based on query, date range, and method
  const filteredPayments = cleanPayments.filter(payment => {
    const invoiceData = getInvoiceForPayment(payment);
    const invoiceNo = (invoiceData?.invoiceNumber || payment.invoiceId || '').toLowerCase();
    const sapDoc = (invoiceData?.sapMiroDoc || '').toLowerCase();
    const utr = (payment.utrCode || '').toLowerCase();
    const query = searchQuery.toLowerCase();
    const clearingDateFormatted = formatDate(payment.paymentDate).toLowerCase();

    // 1. Search Query filter (matches invoice number, sap doc no, UTR, or formatted date)
    const matchesSearch = invoiceNo.includes(query) || 
                          sapDoc.includes(query) || 
                          utr.includes(query) ||
                          clearingDateFormatted.includes(query);

    // 2. Date range filter (clearing date within [fromDateFilter, toDateFilter])
    let matchesDate = true;
    if (payment.paymentDate) {
      try {
        const d = new Date(payment.paymentDate);
        if (!isNaN(d.getTime())) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, '0');
          const dayVal = String(d.getDate()).padStart(2, '0');
          const clearingDateStr = `${y}-${m}-${dayVal}`; // "YYYY-MM-DD"
          
          if (fromDateFilter && clearingDateStr < fromDateFilter) {
            matchesDate = false;
          }
          if (toDateFilter && clearingDateStr > toDateFilter) {
            matchesDate = false;
          }
        }
      } catch (_) {}
    } else {
      if (fromDateFilter || toDateFilter) {
        matchesDate = false;
      }
    }

    // 3. Payment Method filter
    let matchesMethod = true;
    if (paymentMethodFilter !== 'all') {
      matchesMethod = payment.paymentMethod === paymentMethodFilter;
    }

    return matchesSearch && matchesDate && matchesMethod;
  });

  // All filtered payments — shown in scrollable container, no pagination

  const handleDownloadStatement = async () => {
    try {
      const headers = {};
      const token = localStorage.getItem('jwt_token');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';
      const response = await fetch(`${baseUrl}/reports/statement`, { headers });
      if (!response.ok) throw new Error('Failed to download statement');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-Q1-2026.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      alert(err.message || 'Failed to download statement PDF');
    }
  };

  // No dedicated backend CSV export endpoint exists, so build one client-side from the
  // already-filtered ledger rows (keeps the export consistent with what's on screen).
  const handleExportLedger = () => {
    const headers = ['Invoice Number', 'Buyer Reference', 'Payment Date', 'Gross Amount', 'TDS Deducted', 'Net Disbursed', 'UTR Reference', 'Method'];
    const rows = filteredPayments.map(payment => {
      const invData = getInvoiceForPayment(payment);
      const payAmt = payment.amount !== undefined ? payment.amount : (payment.netAmount || 0);
      const tdsAmt = Number(payment.tdsDeducted) || 0; // never a guessed rate
      const grossAmt = payment.grossAmount !== undefined ? payment.grossAmount : payAmt + tdsAmt;
      return [
        invData?.invoiceNumber || payment.invoiceId || '',
        invData?.sapMiroDoc || '',
        formatDate(payment.paymentDate),
        grossAmt,
        tdsAmt,
        payAmt,
        payment.utrCode || '',
        payment.paymentMethod || 'NEFT'
      ];
    });

    const csvContent = [headers, ...rows]
      .map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payment-ledger-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  };

  // No dedicated dispute/query backend endpoint exists yet, so route the inquiry through
  // the same chat endpoint the (now-removed) Communications tab used to send —
  // it still reaches a buyer officer, there's just no thread view for it in the portal.
  const handleRaiseInquiry = async (payment) => {
    const invData = getInvoiceForPayment(payment);
    const message = `Raising a query regarding settlement UTR: ${payment.utrCode || payment.id}, Invoice: ${invData?.invoiceNumber || payment.invoiceId || 'N/A'}. Please review and advise.`;
    try {
      await portal.dashboardHook.sendChatMessage(message);
      portal.addToast('success', 'Your inquiry has been sent to your buyer. A buyer officer will respond shortly.');
    } catch (err) {
      portal.addToast('error', 'Failed to send inquiry. Please try again.');
    }
  };

  // Form 16A is issued by the buyer from TRACES after filing its quarterly
  // return — the portal cannot generate one, and the registry below is a
  // deduction ledger rather than a filing record. So the request goes through
  // the same chat endpoint to Finance instead of faking a download.
  const handleRequestForm16A = async (row) => {
    const message = `Requesting Form 16A TDS certificate — ${row.quarterLabel}, FY ${row.fiscalYearLabel}`
      + `${row.deducteePan ? `, PAN: ${row.deducteePan}` : ''}`
      + `, TDS deducted ₹${Number(row.taxWithheld).toLocaleString('en-IN')} across ${row.paymentCount} payment(s).`;
    try {
      await portal.dashboardHook.sendChatMessage(message);
      portal.addToast('info', 'Form 16A certificates are issued by Finance and are not available for direct download yet. Your request has been sent to your buyer.');
    } catch (err) {
      portal.addToast('error', 'Failed to send certificate request. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <ErrorBoundary>
        <div className="p-4 space-y-4 card">
          <TableSkeleton rows={6} cols={5} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="space-y-6 max-w-full mx-auto animate-fade-in pb-16 relative">

      {/* PAGE HEADER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-4 select-none">
        <div className="space-y-1">
          <h2 className="text-[22px] font-bold text-text-primary flex items-center gap-2">
            <Landmark className="size-5 text-primary shrink-0" /> Payment Tracking
          </h2>
          <p className="text-text-tertiary text-xs font-semibold">
            See which invoices have been paid, when the money was sent, and how much TDS was deducted
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div
            tabIndex={0}
            className="flex items-center gap-2 bg-surface border border-border hover:border-border-em focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-md py-1.5 px-3 text-xs text-text-secondary font-semibold h-9 transition-all duration-150 cursor-pointer tabular-nums"
          >
            <Calendar className="size-4 text-text-tertiary shrink-0" />
            <span>01 Apr 2026 - 30 Jun 2026</span>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-9"
            onClick={handleExportLedger}
          >
            <Download className="size-4 text-text-tertiary shrink-0" />
            <span>Export</span>
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {/* TAB NAVIGATION BAR */}
        <div className="flex border-b border-border select-none bg-surface p-1 rounded-sm shadow-xs w-fit">
          <button
            onClick={() => setDetailTab('status')}
            className={`pb-2 px-5 text-xs font-bold border-b-2 transition-colors duration-150 cursor-pointer flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-t-[3px] ${detailTab === 'status'
              ? 'border-primary text-primary font-extrabold'
              : 'border-transparent text-text-tertiary hover:text-text-primary hover:border-border'
              }`}
          >
            <CheckCircle2 className="size-4 shrink-0" /> Payment status
          </button>
          <button
            onClick={() => setDetailTab('tds')}
            className={`pb-2 px-5 text-xs font-bold border-b-2 transition-colors duration-150 cursor-pointer flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-t-[3px] ${detailTab === 'tds'
              ? 'border-primary text-primary font-extrabold'
              : 'border-transparent text-text-tertiary hover:text-text-primary hover:border-border'
              }`}
          >
            <FileText className="size-4 shrink-0" /> TDS Tax Certificates
          </button>
        </div>

        {/* TAB CONTENT BLOCK */}
        <div className="space-y-6 bg-transparent">
          {/* Tab 1: Payment Status Form */}
          {detailTab === 'status' && (
            <div className="space-y-4 animate-fade-in">
              {/* Search & Inline Filters Controls */}
              <div className="card p-3 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[240px] relative">
                  <input
                    type="text"
                    placeholder="       Search by invoice number, reference, UTR, or date..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="!pl-8 h-9"
                  />
                  <Search className="size-4 text-text-tertiary absolute left-2.5 top-2.5" />
                </div>

                <div className="flex items-center gap-2">
                  <span className="label mb-0 whitespace-nowrap">From</span>
                  <input
                    type="date"
                    value={fromDateFilter}
                    onChange={(e) => setFromDateFilter(e.target.value)}
                    className="h-9 font-mono"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <span className="label mb-0 whitespace-nowrap">To</span>
                  <input
                    type="date"
                    value={toDateFilter}
                    onChange={(e) => setToDateFilter(e.target.value)}
                    className="h-9 font-mono"
                  />
                  {(fromDateFilter || toDateFilter) && (
                    <button
                      onClick={() => { setFromDateFilter(''); setToDateFilter(''); }}
                      className="text-xs text-destructive font-semibold hover:underline cursor-pointer pl-1 transition-colors duration-150"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <span className="label mb-0 whitespace-nowrap">Method</span>
                  <select
                    value={paymentMethodFilter}
                    onChange={(e) => setPaymentMethodFilter(e.target.value)}
                    className="h-9"
                  >
                    <option value="all">All Methods</option>
                    <option value="NEFT">NEFT Transfer</option>
                    <option value="RTGS">RTGS Settlement</option>
                  </select>
                </div>
              </div>

              {/* Payments Table — scrollable, all rows visible */}
              <div className="card w-full overflow-x-auto overflow-y-auto max-h-[520px] custom-scrollbar">
                <table className="w-full text-left border-collapse min-w-[1100px] table-sticky">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="w-36">Invoice Number</th>
                      <th className="w-36">Buyer&apos;s reference</th>
                      <th className="w-28">Payment date</th>
                      <th className="w-32 text-right">Gross Amount</th>
                      <th className="w-32 text-right">TDS Deducted</th>
                      <th className="w-32 text-right">Net Disbursed</th>
                      <th className="min-w-[150px]">UTR / Reference</th>
                      <th className="w-24">Method</th>
                      <th className="w-24">Status</th>
                      <th className="w-28 text-center">Confirmed</th>
                      <th className="text-center w-36">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPayments.map((payment, idx) => {
                      const invData = getInvoiceForPayment(payment);
                      const payAmt = payment.amount !== undefined ? payment.amount : (payment.netAmount || 0);
                      const tdsAmt = Number(payment.tdsDeducted) || 0; // never a guessed rate
                      const grossAmt = payment.grossAmount !== undefined ? payment.grossAmount : payAmt + tdsAmt;

                      return (
                        <tr key={payment.id || idx}>
                          <td className="whitespace-nowrap">
                            <span className="text-primary font-bold hover:underline cursor-pointer select-all whitespace-nowrap">
                              {invData?.invoiceNumber || payment.invoiceId}
                            </span>
                          </td>
                          <td className="font-mono font-semibold text-text-primary whitespace-nowrap">
                            {invData?.sapMiroDoc || '—'}
                          </td>
                          <td className="font-medium font-mono text-text-secondary whitespace-nowrap tabular-nums">
                            {formatDate(payment.paymentDate)}
                          </td>
                          <td className="font-bold text-text-primary text-right font-mono whitespace-nowrap tabular-nums">
                            ₹ {grossAmt.toLocaleString('en-IN')}.00
                          </td>
                          <td className="font-medium text-destructive text-right font-mono whitespace-nowrap tabular-nums">
                            - ₹ {tdsAmt.toLocaleString('en-IN')}.00
                          </td>
                          <td className="font-extrabold text-emerald-400 text-right font-mono whitespace-nowrap tabular-nums">
                            ₹ {payAmt.toLocaleString('en-IN')}.00
                          </td>
                          <td className="font-mono font-bold text-text-primary select-all break-all">
                            {payment.utrCode}
                          </td>
                          <td className="font-semibold text-text-secondary text-xs whitespace-nowrap">
                            {payment.paymentMethod || 'NEFT'}
                          </td>
                          <td className="whitespace-nowrap">
                            <StatusBadge label="Cleared" variant={paymentStatusVariant('Cleared')} />
                          </td>
                          <td className="text-center whitespace-nowrap">
                            {sapPayments == null ? (
                              <Loader2 className="size-3.5 animate-spin text-text-tertiary inline-block" />
                            ) : isConfirmedBySap(payment) ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400" title="Your buyer’s payment records confirm this payment">
                                <ShieldCheck className="size-3.5" /> Confirmed
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400" title="Not yet in your buyer’s payment records">
                                <ShieldAlert className="size-3.5" /> Not confirmed yet
                              </span>
                            )}
                          </td>
                          <td className="text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1.5">
                              <Button
                                variant="outline"
                                size="xs"
                                onClick={() => handleRaiseInquiry(payment)}
                                title="Raise query / dispute"
                              >
                                Query
                              </Button>
                              <Button
                                variant="default"
                                size="xs"
                                onClick={handleDownloadStatement}
                                title="Download Advice Slip"
                              >
                                Advice
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredPayments.length === 0 && (
                      <tr>
                        <td colSpan={11} className="!border-b-0">
                          <EmptyState title="No matching payments" description="No cleared invoice matching the filters found." />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* SAP'S OWN PAYMENT LEDGER — what the ERP says, unfiltered.
                  Kept as a separate block rather than merged into the table
                  above, because a row here that has no counterpart above is
                  itself the useful signal: SAP paid something the portal has
                  no record of. */}
              <div className="card">
                <div className="p-3 border-b border-border flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-text-primary tracking-wider uppercase flex items-center gap-2">
                      <ShieldCheck className="size-4 text-primary shrink-0" /> Payments recorded by your buyer
                    </h3>
                    <p className="text-[10px] text-text-tertiary font-semibold mt-1">
                      Payments read straight from your buyer’s records for your company, shown exactly as they were reported
                    </p>
                  </div>
                  <span className="text-[10px] font-bold font-mono bg-surface2 border border-border px-2.5 py-1 rounded-md text-text-secondary tabular-nums">
                    {sapPayments == null ? 'Reading…' : `${sapPayments.length} payment(s)`}
                  </span>
                </div>

                {sapPayments == null ? (
                  <div className="p-4"><TableSkeleton rows={3} cols={6} /></div>
                ) : sapPayments.length === 0 ? (
                  <EmptyState
                    title="No payments recorded yet"
                    description="Your buyer has not recorded any completed payments to your company yet."
                  />
                ) : (
                  <div className="w-full overflow-x-auto overflow-y-auto max-h-[420px] custom-scrollbar">
                    <table className="w-full text-left border-collapse min-w-[1000px] table-sticky">
                      <thead className="sticky top-0 z-10">
                        <tr>
                          <th className="w-36">Invoice reference</th>
                          <th className="w-36">Payment reference</th>
                          <th className="w-28">Payment date</th>
                          <th className="w-32 text-right">Gross Amount</th>
                          <th className="w-32 text-right">TDS Deducted</th>
                          <th className="w-32 text-right">Net Disbursed</th>
                          <th className="min-w-[150px]">UTR / Reference</th>
                          <th className="w-24">Method</th>
                          <th className="w-24">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sapPayments.map((row, idx) => (
                          <tr key={row.clearingDocument || row.miroDoc || idx}>
                            <td className="font-mono font-bold text-text-primary whitespace-nowrap">
                              {row.miroDoc || '—'}
                              {row.fiscalYear && (
                                <span className="text-[9px] text-text-tertiary ml-1">/ {row.fiscalYear}</span>
                              )}
                            </td>
                            <td className="font-mono font-semibold text-text-primary whitespace-nowrap">
                              {row.clearingDocument || '—'}
                            </td>
                            <td className="font-medium font-mono text-text-secondary whitespace-nowrap tabular-nums">
                              {formatDate(row.clearingDate)}
                            </td>
                            <td className="font-bold text-text-primary text-right font-mono whitespace-nowrap tabular-nums">
                              ₹ {Number(row.grossAmount || 0).toLocaleString('en-IN')}
                            </td>
                            <td className="font-medium text-destructive text-right font-mono whitespace-nowrap tabular-nums">
                              - ₹ {Number(row.tdsDeducted || 0).toLocaleString('en-IN')}
                            </td>
                            <td className="font-extrabold text-emerald-400 text-right font-mono whitespace-nowrap tabular-nums">
                              ₹ {Number(row.netDisbursed || 0).toLocaleString('en-IN')}
                            </td>
                            <td className="font-mono font-bold text-text-primary select-all break-all">
                              {row.utrReference || '—'}
                            </td>
                            <td className="font-semibold text-text-secondary text-xs whitespace-nowrap">
                              {row.paymentMethod || '—'}
                            </td>
                            <td className="whitespace-nowrap">
                              <StatusBadge label={row.status || 'CLEARED'} variant={paymentStatusVariant('Cleared')} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

            </div>
          )}

          {/* Tab 2: TDS Certificates Form */}
          {detailTab === 'tds' && (
            <div className="space-y-4 animate-fade-in">
              {/* Search & Inline Filters Controls */}
              <div className="card p-3 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="label mb-0 whitespace-nowrap">Fiscal Year</span>
                  <select
                    value={tdsYearFilter}
                    onChange={(e) => setTdsYearFilter(e.target.value)}
                    className="h-9"
                  >
                    <option value="all">All Years</option>
                    {tdsYears.map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="label mb-0 whitespace-nowrap">Quarter</span>
                  <select
                    value={tdsQuarterFilter}
                    onChange={(e) => setTdsQuarterFilter(e.target.value)}
                    className="h-9"
                  >
                    <option value="all">All Quarters</option>
                    <option value="Q1">Q1 (Apr - Jun)</option>
                    <option value="Q2">Q2 (Jul - Sep)</option>
                    <option value="Q3">Q3 (Oct - Dec)</option>
                    <option value="Q4">Q4 (Jan - Mar)</option>
                  </select>
                </div>
              </div>

              {/* TDS Registry Table — scrollable, all rows visible */}
              <div className="card w-full overflow-x-auto overflow-y-auto max-h-[520px] custom-scrollbar">
                <table className="w-full text-left border-collapse min-w-[1100px] table-sticky">
                  <thead className="sticky top-0 z-10">
                    <tr>
                      <th className="whitespace-nowrap">Fiscal Year</th>
                      <th className="whitespace-nowrap">Quarter</th>
                      <th className="whitespace-nowrap">Section</th>
                      <th className="whitespace-nowrap">Deductor TAN</th>
                      <th className="whitespace-nowrap">Deductee PAN</th>
                      <th className="text-right whitespace-nowrap">Tax Withheld</th>
                      <th className="text-right whitespace-nowrap">Payments</th>
                      <th className="text-center whitespace-nowrap">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-xs">
                    {allTds.map((row) => (
                      <tr key={row.id}>
                        <td className="font-semibold font-sans text-text-primary whitespace-nowrap">
                          {row.fiscalYearLabel}
                        </td>
                        <td className="font-bold font-sans text-text-primary whitespace-nowrap">
                          {row.quarterLabel}
                        </td>
                        {/* Section and TAN come from SAP's remittance advice.
                            They are null until it supplies them — shown as a
                            dash rather than a plausible-looking placeholder. */}
                        <td className="font-semibold text-text-secondary whitespace-nowrap">
                          {row.section || '—'}
                        </td>
                        <td className="font-medium text-text-primary select-all whitespace-nowrap">
                          {row.deductorTan || '—'}
                        </td>
                        <td className="font-medium text-text-primary select-all whitespace-nowrap">
                          {row.deducteePan || '—'}
                        </td>
                        <td className="font-extrabold text-emerald-400 text-right whitespace-nowrap tabular-nums">
                          ₹ {Number(row.taxWithheld).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="text-right whitespace-nowrap tabular-nums text-text-secondary">
                          {row.paymentCount}
                        </td>
                        <td className="text-center font-sans whitespace-nowrap">
                          <Button
                            variant="default"
                            size="xs"
                            onClick={() => handleRequestForm16A(row)}
                            title="Request the Form 16A certificate from Finance"
                          >
                            Request Certificate
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {tdsLoading && (
                      <tr>
                        <td colSpan={8} className="!border-b-0">
                          <div className="flex items-center justify-center gap-2 py-6 text-xs text-text-tertiary">
                            <Loader2 className="size-4 animate-spin" /> Loading TDS deductions…
                          </div>
                        </td>
                      </tr>
                    )}
                    {!tdsLoading && filteredTds.length === 0 && (
                      <tr>
                        <td colSpan={8} className="!border-b-0">
                          <EmptyState
                            title="No TDS deducted yet"
                            description="Tax withheld will appear here once payments with a TDS deduction have been recorded against your account."
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      </div>
    </ErrorBoundary>
  );
}
