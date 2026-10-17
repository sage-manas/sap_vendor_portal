'use client';

import React, { useState, useEffect } from 'react';
import { CheckCircle2, Copy, Download, FileText, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ErrorBoundary from '@/components/ErrorBoundary';
import TableSkeleton from '@/components/ui/TableSkeleton';
import StatusBadge from '@/components/ui/StatusBadge';
import Spinner from '@/components/ui/Spinner';
import DataTable from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/Page';
import { Section } from '@/components/ui/Card';
import { Tabs } from '@/components/ui/controls';
import { paymentStatusVariant } from '@/lib/statusColors';
import { usePortal } from '@/lib/portal-context';
import { displayDate } from '@/lib/displayDate';

const formatInr = (amount) =>
  Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// dd.mm.yyyy — kept as a search key: people type dates the way their bank
// statement prints them.
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


const sum = (rows, pick) => rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);

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

  // Every invoice this payment settled — a remittance can cover more than
  // one (an F110 run pays several invoices under one clearing document, see
  // issue #63), so `payment.items` is a list, not a single invoiceId. It
  // used to synthesise a match when none was found — inventing a SAP MIRO
  // number as "510560" + the last four digits of the payment id, plus a
  // back-computed 18% tax split. A number shaped exactly like SAP's own is
  // the worst kind of placeholder, so an unsettled item now simply has no
  // invoice and the fields render as dashes.
  const getInvoicesForPayment = (payment) => {
    if (!payment) return [];
    const items = payment.items?.length ? payment.items : [{ invoiceId: payment.invoiceId, invoiceNumber: payment.invoiceNumber, sapMiroDoc: payment.sapMiroDoc }];
    return items.map((item) => (state?.invoices || []).find(
      (i) => i.id === item.invoiceId || i.invoiceNumber === item.invoiceId || i.invoiceNumber === item.invoiceNumber,
    ) || item);
  };
  // Comma-joined invoice numbers for a table cell or CSV column — the common
  // case (one invoice) reads exactly as it always did.
  const invoiceLabelFor = (payment) => getInvoicesForPayment(payment)
    .map((inv) => inv?.invoiceNumber || inv?.invoiceId)
    .filter(Boolean)
    .join(', ') || null;
  const miroDocLabelFor = (payment) => getInvoicesForPayment(payment)
    .map((inv) => inv?.sapMiroDoc)
    .filter(Boolean)
    .join(', ') || null;

  // Amounts come off the payment SAP reported. Only the gross falls back, and
  // only arithmetically — net plus the TDS actually deducted, never a guessed
  // rate applied to a number nobody supplied. Sums per remittance (issue #63):
  // one row is one Payment, and these are its totals across every invoice it
  // settled, matching what the bank shows.
  const netOf = (payment) => (payment.amount !== undefined ? payment.amount : (payment.netAmount || 0));
  const tdsOf = (payment) => Number(payment.tdsDeducted) || 0;
  const grossOf = (payment) => (payment.grossAmount !== undefined ? payment.grossAmount : netOf(payment) + tdsOf(payment));

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

  const filteredTds = tdsQuarters.filter(row => {
    const matchesYear = tdsYearFilter === 'all' || row.fiscalYearLabel === tdsYearFilter;
    const matchesQuarter = tdsQuarterFilter === 'all' || row.quarter === tdsQuarterFilter;
    return matchesYear && matchesQuarter;
  });

  // Filter payments based on query, date range, and method
  const filteredPayments = cleanPayments.filter(payment => {
    const invoiceNo = (invoiceLabelFor(payment) || '').toLowerCase();
    const sapDoc = (miroDocLabelFor(payment) || '').toLowerCase();
    const utr = (payment.utrCode || '').toLowerCase();
    const query = searchQuery.toLowerCase();
    // Both the dd.mm.yyyy form and the date as displayed.
    const dates = `${formatDate(payment.paymentDate)} ${displayDate(payment.paymentDate)}`.toLowerCase();

    // 1. Search Query filter (matches invoice number, sap doc no, UTR, or date)
    const matchesSearch = invoiceNo.includes(query) ||
                          sapDoc.includes(query) ||
                          utr.includes(query) ||
                          dates.includes(query);

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
    const rows = filteredPayments.map(payment => [
      invoiceLabelFor(payment) || '',
      miroDocLabelFor(payment) || '',
      formatDate(payment.paymentDate),
      grossOf(payment),
      tdsOf(payment),
      netOf(payment),
      payment.utrCode || '',
      payment.paymentMethod || 'NEFT'
    ]);

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

  // These two used to promise the supplier a buyer officer would respond
  // (issue #109) and later route through supplier messaging, which was
  // confirmed out of scope and removed entirely (issue #168). This does the
  // part the portal can honestly do: assemble the reference the supplier
  // needs to quote and put it on the clipboard. Routing it is the supplier's
  // own email or phone call, and the copy says so instead of promising a
  // reply.
  const copyForBuyer = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      portal.addToast('success', `${what} copied. The portal cannot message your buyer — send this to their accounts team.`);
    } catch (err) {
      // Clipboard is unavailable over plain HTTP and in some browsers. Showing
      // the reference is still better than silently doing nothing.
      portal.addToast('info', `${what}: ${text}`);
    }
  };

  const handleRaiseInquiry = (payment) =>
    copyForBuyer(
      `Query regarding settlement UTR ${payment.utrCode || payment.id}, invoice ${invoiceLabelFor(payment) || 'N/A'}. Please review and advise.`,
      'Query reference',
    );

  // Form 16A is issued by the buyer from TRACES after filing its quarterly
  // return — the portal cannot generate one, and the registry below is a
  // deduction ledger rather than a filing record.
  const handleRequestForm16A = (row) =>
    copyForBuyer(
      `Form 16A request — ${row.quarterLabel}, FY ${row.fiscalYearLabel}`
      + `${row.deducteePan ? `, PAN ${row.deducteePan}` : ''}`
      + `, TDS deducted ₹${Number(row.taxWithheld).toLocaleString('en-IN')} across ${row.paymentCount} payment(s).`,
      'Certificate request',
    );

  const confirmedCell = (payment) => (sapPayments == null ? (
    <Spinner size={14} label="Checking your buyer's records" />
  ) : isConfirmedBySap(payment) ? (
    <span className="inline-flex items-center gap-1.5 text-success" title="Your buyer’s payment records confirm this payment">
      <CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden="true" /> Confirmed
    </span>
  ) : (
    <span className="text-fg-muted" title="Not yet in your buyer’s payment records">Not confirmed yet</span>
  ));

  const paymentColumns = [
    { key: 'invoice', header: 'Invoice', primary: true, render: (p) => <span className="mono">{invoiceLabelFor(p) || '—'}</span> },
    { key: 'buyerRef', header: 'Buyer’s reference', render: (p) => <span className="mono">{miroDocLabelFor(p) || '—'}</span> },
    { key: 'date', header: 'Paid on', render: (p) => displayDate(p.paymentDate) },
    { key: 'gross', header: 'Gross (₹)', align: 'right', render: (p) => <span className="mono">{formatInr(grossOf(p))}</span> },
    { key: 'tds', header: 'TDS (₹)', align: 'right', render: (p) => <span className="mono text-fg-muted">{formatInr(tdsOf(p))}</span> },
    { key: 'net', header: 'Net paid (₹)', align: 'right', render: (p) => <span className="mono font-medium">{formatInr(netOf(p))}</span> },
    { key: 'utr', header: 'UTR', render: (p) => <span className="mono">{p.utrCode || '—'}</span> },
    { key: 'method', header: 'Method', render: (p) => p.paymentMethod || 'NEFT' },
    { key: 'status', header: 'Status', render: () => <StatusBadge label="Cleared" variant={paymentStatusVariant('Cleared')} /> },
    { key: 'confirmed', header: 'Confirmed', render: confirmedCell },
  ];

  const sapColumns = [
    {
      key: 'miroDoc',
      header: 'Invoice reference',
      primary: true,
      render: (row) => (
        <span className="mono">
          {row.miroDoc || '—'}
          {row.fiscalYear && <span className="text-fg-subtle"> / {row.fiscalYear}</span>}
        </span>
      ),
    },
    { key: 'clearingDocument', header: 'Payment reference', render: (row) => <span className="mono">{row.clearingDocument || '—'}</span> },
    { key: 'clearingDate', header: 'Paid on', render: (row) => displayDate(row.clearingDate) },
    { key: 'gross', header: 'Gross (₹)', align: 'right', render: (row) => <span className="mono">{formatInr(row.grossAmount)}</span> },
    { key: 'tds', header: 'TDS (₹)', align: 'right', render: (row) => <span className="mono text-fg-muted">{formatInr(row.tdsDeducted)}</span> },
    { key: 'net', header: 'Net paid (₹)', align: 'right', render: (row) => <span className="mono font-medium">{formatInr(row.netDisbursed)}</span> },
    { key: 'utr', header: 'UTR', render: (row) => <span className="mono">{row.utrReference || '—'}</span> },
    { key: 'method', header: 'Method', render: (row) => row.paymentMethod || '—' },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge label={row.status || 'CLEARED'} variant={paymentStatusVariant('Cleared')} /> },
  ];

  const tdsColumns = [
    { key: 'fiscalYearLabel', header: 'Fiscal year', primary: true },
    { key: 'quarterLabel', header: 'Quarter' },
    // Section and TAN come from SAP's remittance advice. They are null until
    // it supplies them — shown as a dash rather than a plausible placeholder.
    { key: 'section', header: 'Section', render: (row) => <span className="mono">{row.section || '—'}</span> },
    { key: 'deductorTan', header: 'Deductor TAN', render: (row) => <span className="mono">{row.deductorTan || '—'}</span> },
    { key: 'deducteePan', header: 'Deductee PAN', render: (row) => <span className="mono">{row.deducteePan || '—'}</span> },
    { key: 'taxWithheld', header: 'Tax withheld (₹)', align: 'right', render: (row) => <span className="mono">{formatInr(row.taxWithheld)}</span> },
    { key: 'paymentCount', header: 'Payments', align: 'right', render: (row) => <span className="mono">{row.paymentCount}</span> },
  ];

  if (isLoading) {
    return (
      <ErrorBoundary>
        <div className="card">
          <TableSkeleton rows={6} cols={5} />
        </div>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <div className="pb-16">
        <PageHeader
          title="Payments"
          description="Which invoices have been paid, when the money was sent, and how much TDS was deducted."
          primary={detailTab === 'status' ? (
            <Button variant="secondary" onClick={handleExportLedger}>
              <Download strokeWidth={1.5} /> Export CSV
            </Button>
          ) : null}
        />

        <Tabs
          aria-label="Payments views"
          value={detailTab}
          onValueChange={setDetailTab}
          items={[
            { value: 'status', label: 'Payments', count: cleanPayments.length },
            { value: 'tds', label: 'TDS deductions', count: tdsLoading ? undefined : tdsQuarters.length },
          ]}
        />

        {detailTab === 'status' && (
          <div className="pt-4">
            <div className="mb-3 flex flex-wrap items-end gap-2">
              <div className="relative min-w-60 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" strokeWidth={1.5} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search payments"
                  placeholder="Invoice, reference, UTR or date"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8!"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-fg-muted">
                From
                <input type="date" value={fromDateFilter} onChange={(e) => setFromDateFilter(e.target.value)} className="w-40!" />
              </label>
              <label className="flex items-center gap-2 text-sm text-fg-muted">
                To
                <input type="date" value={toDateFilter} onChange={(e) => setToDateFilter(e.target.value)} className="w-40!" />
              </label>
              {(fromDateFilter || toDateFilter) && (
                <Button variant="ghost" size="sm" onClick={() => { setFromDateFilter(''); setToDateFilter(''); }}>Clear dates</Button>
              )}
              <select
                aria-label="Payment method"
                value={paymentMethodFilter}
                onChange={(e) => setPaymentMethodFilter(e.target.value)}
                className="w-36!"
              >
                <option value="all">All methods</option>
                <option value="NEFT">NEFT</option>
                <option value="RTGS">RTGS</option>
              </select>
            </div>

            <DataTable
              caption="Payments"
              columns={paymentColumns}
              rows={filteredPayments}
              getRowId={(p, i) => p.id || i}
              rowLabel={(p) => invoiceLabelFor(p) || p.utrCode || 'payment'}
              maxHeight="520px"
              empty={cleanPayments.length
                ? 'No payments match these filters.'
                : 'No payments yet — they appear here once your buyer clears an invoice.'}
              rowActions={(p) => [
                { label: 'Copy query for your buyer', icon: Copy, onClick: () => handleRaiseInquiry(p) },
                { label: 'Download statement (PDF)', icon: FileText, onClick: handleDownloadStatement },
              ]}
              totals={filteredPayments.length > 1 ? {
                label: `${filteredPayments.length} payments`,
                gross: <span className="mono">{formatInr(sum(filteredPayments, grossOf))}</span>,
                tds: <span className="mono">{formatInr(sum(filteredPayments, tdsOf))}</span>,
                net: <span className="mono">{formatInr(sum(filteredPayments, netOf))}</span>,
              } : undefined}
            />

            {/* SAP'S OWN PAYMENT LEDGER — what the ERP says, unfiltered.
                Kept as a separate block rather than merged into the table
                above, because a row here that has no counterpart above is
                itself the useful signal: SAP paid something the portal has
                no record of. */}
            <Section
              className="mt-10"
              title="Payments recorded by your buyer"
              description={`Read straight from your buyer’s records for your company, exactly as reported${sapPayments == null ? '' : ` · ${sapPayments.length} payment${sapPayments.length === 1 ? '' : 's'}`}.`}
            >
              <DataTable
                caption="Payments recorded by your buyer"
                columns={sapColumns}
                rows={sapPayments || []}
                loading={sapPayments == null}
                getRowId={(row, i) => row.clearingDocument || row.miroDoc || i}
                rowLabel={(row) => row.clearingDocument || row.miroDoc || 'payment'}
                maxHeight="420px"
                empty="Your buyer hasn’t recorded any completed payments to your company yet."
              />
            </Section>
          </div>
        )}

        {detailTab === 'tds' && (
          <div className="pt-4">
            <div className="mb-3 flex flex-wrap gap-2">
              <select aria-label="Fiscal year" value={tdsYearFilter} onChange={(e) => setTdsYearFilter(e.target.value)} className="w-40!">
                <option value="all">All years</option>
                {tdsYears.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
              <select aria-label="Quarter" value={tdsQuarterFilter} onChange={(e) => setTdsQuarterFilter(e.target.value)} className="w-44!">
                <option value="all">All quarters</option>
                <option value="Q1">Q1 (Apr–Jun)</option>
                <option value="Q2">Q2 (Jul–Sep)</option>
                <option value="Q3">Q3 (Oct–Dec)</option>
                <option value="Q4">Q4 (Jan–Mar)</option>
              </select>
            </div>
            <DataTable
              caption="TDS deducted by quarter"
              columns={tdsColumns}
              rows={filteredTds}
              loading={tdsLoading}
              rowLabel={(row) => `${row.quarterLabel} ${row.fiscalYearLabel}`}
              maxHeight="520px"
              empty="No TDS deducted yet — tax withheld appears here once a payment with a TDS deduction is recorded against your account."
              inlineActions={(row) => (
                <Button variant="ghost" size="sm" onClick={() => handleRequestForm16A(row)} title="Copy a Form 16A request to send to your buyer's finance team">
                  <Copy strokeWidth={1.5} /> Copy Form 16A request
                </Button>
              )}
            />
            <p className="mt-3 max-w-[72ch] text-xs text-fg-subtle">
              A deduction ledger from the payments this portal has recorded — not a Form 16A. Your buyer issues the certificate from TRACES after filing its quarterly return.
            </p>
          </div>
        )}
      </div>
    </ErrorBoundary>
  );
}
