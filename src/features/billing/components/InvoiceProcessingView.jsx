import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import Spinner from '@/components/ui/Spinner';
import DataTable from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/Page';
import { invoiceStatusVariant } from '@/lib/statusColors';
import { displayDate } from '@/lib/displayDate';


const inr = (value) => Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Issue #113: the column header used to assert every invoice was taxed at a
// flat 18%, which #66's per-line GST redesign made false — a line's own
// gstRate is nullable and independent of every other line's. This is the
// invoice's real effective rate, derived from its own totals rather than
// asserted, so it only ever reads as what actually happened to this
// document: taxAmount / subTotal, blended across however many rates its
// lines actually carried. subTotal is the pre-tax value, so a 0 or missing
// one means there is nothing honest to divide by — shown as nothing, not 0%.
const effectiveGstRate = (invoice) => {
  const subTotal = Number(invoice?.subTotal);
  const taxAmount = Number(invoice?.taxAmount);
  if (!Number.isFinite(subTotal) || subTotal <= 0 || !Number.isFinite(taxAmount)) return null;
  return (taxAmount / subTotal) * 100;
};

export default function InvoiceProcessingView({ state }) {
  const submittedInvoices = state.invoices;
  const sapMiroDocuments = state.sapMiroDocuments;
  // Filtered, and guarded below: an invoice carries no MIRO number until AP has
  // posted it and reconciliation has recognised it, and `new Set([null])
  // .has(null)` would badge every unposted invoice as confirmed by SAP.
  const sapMiroDocNumbers = new Set((sapMiroDocuments || []).map(d => d.miroDoc).filter(Boolean));
  const isConfirmedInSap = (inv) => Boolean(inv.sapMiroDoc) && sapMiroDocNumbers.has(inv.sapMiroDoc);
  const sapPaymentDetails = state.sapPaymentDetails || {};

  const columns = [
    {
      key: 'invoice',
      header: 'Your invoice',
      primary: true,
      render: (inv) => (
        <div className="leading-tight">
          <span className="mono text-fg">{inv.invoiceNumber}</span>
          <span className="block text-xs text-fg-subtle">{displayDate(inv.invoiceDate)}</span>
        </div>
      ),
    },
    {
      key: 'buyerRef',
      header: 'Buyer’s reference',
      render: (inv) => (
        // The portal posts nothing to SAP: this number exists only once AP has
        // posted the invoice and the reconciliation has recognised it.
        <div className="leading-tight">
          {inv.sapMiroDoc
            ? <span className="mono text-fg">{inv.sapMiroDoc}</span>
            : <span className="text-fg-muted">Awaiting the buyer’s finance team</span>}
          <span className="mono block text-xs text-fg-subtle">Ref {inv.id}</span>
        </div>
      ),
    },
    { key: 'poId', header: 'Order', mono: true },
    {
      key: 'value',
      header: 'Value (₹)',
      align: 'right',
      render: (inv) => {
        const rate = effectiveGstRate(inv);
        return (
          <div className="leading-tight">
            <span className="mono text-fg">{inr(inv.totalAmount)}</span>
            {rate !== null && (
              <span className="block text-xs text-fg-subtle">
                GST {rate.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (inv) => <StatusBadge label={inv.status || 'Submitted'} variant={invoiceStatusVariant(inv.status)} />,
    },
    {
      key: 'confirmed',
      header: 'Confirmed',
      render: (inv) => (sapMiroDocuments === null ? (
        <Spinner size={14} label="Checking with your buyer's system" />
      ) : isConfirmedInSap(inv) ? (
        <span className="inline-flex items-center gap-1.5 text-success" title="The buyer’s finance system confirms this invoice">
          <CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden="true" /> Confirmed
        </span>
      ) : (
        <span className="text-fg-muted" title="The buyer’s finance team has not recorded this invoice yet">Not confirmed yet</span>
      )),
    },
    {
      key: 'payment',
      header: 'Payment',
      render: (inv) => {
        const paymentDetail = sapPaymentDetails[inv.sapMiroDoc];
        if (!paymentDetail) {
          return <span className="text-fg-subtle">{isConfirmedInSap(inv) ? 'Not yet cleared' : '—'}</span>;
        }
        return (
          <div className="leading-tight">
            <span className="text-fg">{paymentDetail.status} · net <span className="mono">₹{inr(paymentDetail.netDisbursed)}</span></span>
            <span className="block text-xs text-fg-subtle">
              TDS <span className="mono">₹{inr(paymentDetail.tdsDeducted)}</span> · paid {displayDate(paymentDetail.clearingDate)}
              {paymentDetail.utrReference && <> · UTR <span className="mono">{paymentDetail.utrReference}</span></>}
            </span>
          </div>
        );
      },
    },
  ];

  return (
    <div className="pb-12">
      <PageHeader
        title="Invoices"
        description="Invoices your buyer’s finance team has posted, and whether they’ve been confirmed and paid."
      />
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={submittedInvoices}
        rowLabel={(inv) => inv.invoiceNumber}
        empty="No invoices yet — once your buyer’s finance team posts an invoice against your delivery, it appears here."
      />
    </div>
  );
}
