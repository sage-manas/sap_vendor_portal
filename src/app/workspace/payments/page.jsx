'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { paymentService } from '@/features/payments/services/paymentService';
import { PageHeader, Notice, Table, Loading, useResource, formatDate } from '@/components/console/primitives';

// Every settlement made against this workspace's invoices, across every
// supplier, plus the TDS deducted along the way — the finance (and
// client_admin) tenant-wide view. GET /api/payments and /api/payments/
// tds-summary already return every vendor's rows to tenant staff with no
// vendorId filter (see backend/tests/tenant-wide-visibility.test.js).
//
// Read-only: a payment is F110's own record, not something this portal
// posts (PROJECT_CONTEXT.md §5.6) — nothing here is editable.
//
// Two views of the same TDS data, deliberately not merged into one table:
//   - "TDS deducted, by quarter" sums across every supplier. A quarter more
//     than one supplier contributed to withholds section/deductorTan/
//     deducteePan as null rather than attributing one supplier's compliance
//     identifiers to a blended total (see the getTdsSummary comment in
//     backend/controllers/payment.controller.js) — the sum stays correct,
//     the identity fields do not pretend to belong to any one of them.
//   - "TDS deducted, by supplier" (?byVendor=true) is where that same money
//     is broken out per supplier instead, each row correctly carrying its
//     own PAN/section where SAP has supplied one.

const money = (value, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(Number(value || 0));

const SectionTitle = ({ children }) => (
  <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-text-tertiary">{children}</h2>
);

export default function WorkspacePaymentsPage() {
  const router = useRouter();
  const payments = useResource(() => paymentService.getPayments({ limit: 200 }));
  const tdsByQuarter = useResource(() => paymentService.getTdsSummary());
  const tdsByVendor = useResource(() => paymentService.getTdsSummary({ byVendor: true }), 'byVendor');

  const paymentRows = payments.data?.payments || [];
  const quarterRows = tdsByQuarter.data?.quarters || [];
  const vendorRows = tdsByVendor.data?.quarters || [];

  return (
    <>
      <PageHeader title="Payments" caption="Every settlement made against this workspace's invoices, across every supplier" />
      <Notice tone="error">{payments.error || tdsByQuarter.error || tdsByVendor.error}</Notice>

      <div className="space-y-8">
        <section className="space-y-2">
          <SectionTitle>Payments</SectionTitle>
          {payments.loading ? (
            <Loading label="Loading payments" />
          ) : (
            <Table
              columns={[
                { key: 'id', header: 'Payment', render: (row) => <span className="mono">{row.id}</span> },
                { key: 'vendorId', header: 'Supplier' },
                { key: 'invoiceId', header: 'Invoice', render: (row) => <span className="mono">{row.invoiceRef || row.invoiceId}</span> },
                { key: 'grossAmount', header: 'Gross', render: (row) => <span className="mono">{money(row.grossAmount)}</span> },
                { key: 'tdsDeducted', header: 'TDS', render: (row) => <span className="mono">{money(row.tdsDeducted)}</span> },
                { key: 'netAmount', header: 'Net', render: (row) => <span className="mono">{money(row.netAmount)}</span> },
                { key: 'utrCode', header: 'UTR', render: (row) => <span className="mono">{row.utrCode || '—'}</span> },
                { key: 'paymentMethod', header: 'Method' },
                { key: 'paymentDate', header: 'Paid', render: (row) => <span className="mono text-[11px]">{formatDate(row.paymentDate)}</span> },
              ]}
              rows={paymentRows.map((payment) => ({ ...payment, key: payment.id }))}
              onRowClick={(row) => router.push(`/workspace/suppliers/${row.vendorId}`)}
              empty="No payments recorded yet."
            />
          )}
        </section>

        <section className="space-y-2">
          <SectionTitle>TDS deducted, by quarter</SectionTitle>
          {tdsByQuarter.loading ? (
            <Loading label="Loading TDS summary" />
          ) : (
            <Table
              columns={[
                { key: 'quarter', header: 'Quarter', render: (row) => `${row.fiscalYearLabel} ${row.quarterLabel}` },
                { key: 'paymentCount', header: 'Payments', render: (row) => <span className="mono">{row.paymentCount}</span> },
                { key: 'grossPaid', header: 'Gross paid', render: (row) => <span className="mono">{money(row.grossPaid)}</span> },
                { key: 'taxWithheld', header: 'Tax withheld', render: (row) => <span className="mono">{money(row.taxWithheld)}</span> },
                { key: 'section', header: 'Section', render: (row) => row.section || '—' },
              ]}
              rows={quarterRows.map((row) => ({ ...row, key: row.id }))}
              empty="No TDS deducted yet."
            />
          )}
          {tdsByQuarter.data?.disclaimer && (
            <p className="text-[11px] text-text-tertiary">{tdsByQuarter.data.disclaimer}</p>
          )}
        </section>

        <section className="space-y-2">
          <SectionTitle>TDS deducted, by supplier</SectionTitle>
          {tdsByVendor.loading ? (
            <Loading label="Loading TDS by supplier" />
          ) : (
            <Table
              columns={[
                { key: 'quarter', header: 'Quarter', render: (row) => `${row.fiscalYearLabel} ${row.quarterLabel}` },
                { key: 'vendorId', header: 'Supplier' },
                { key: 'paymentCount', header: 'Payments', render: (row) => <span className="mono">{row.paymentCount}</span> },
                { key: 'taxWithheld', header: 'Tax withheld', render: (row) => <span className="mono">{money(row.taxWithheld)}</span> },
                { key: 'deducteePan', header: 'PAN', render: (row) => row.deducteePan || '—' },
              ]}
              rows={vendorRows.map((row) => ({ ...row, key: row.id }))}
              onRowClick={(row) => router.push(`/workspace/suppliers/${row.vendorId}`)}
              empty="No TDS deducted yet."
            />
          )}
        </section>
      </div>
    </>
  );
}
