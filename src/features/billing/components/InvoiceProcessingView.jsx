import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import Spinner from '@/components/ui/Spinner';
import { Button } from '@/components/ui/button';
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
  const sapMiroStatus = state.sapMiroStatus ?? 'loading';
  const retrySapMiroStatus = state.retrySapMiroStatus;

  // One list, not two — the same rule PurchaseOrdersView applies to an order
  // SAP raised directly. An invoice AP posted (MIRO) is real whether or not
  // jobs/handlers/sweepInvoices.js has recorded it here, so it belongs in
  // this table, carrying `sapOnly` so the row is honest that nothing here is
  // tracking it yet.
  //
  // This is not only the gap between SAP posting and the next sweep. Where
  // AP invoiced a PO with no goods receipt — legal whenever the vendor
  // master has GR-based invoice verification off — the sweep can create no
  // row at all, because an Invoice must hang off a GRN or an invoicing-plan
  // date (a database CHECK). Until that is fixed (issue #300), this is the
  // only place such an invoice is visible to the supplier at all.
  const trackedMiroDocs = new Set((submittedInvoices || []).map(inv => inv.sapMiroDoc).filter(Boolean));
  const poNumberOf = (document) =>
    (document.items || []).map(item => item.poNumber).filter(Boolean)[0] || document.poNumber || null;

  const sapOnlyInvoices = (Array.isArray(sapMiroDocuments) ? sapMiroDocuments : [])
    .filter(document => document.miroDoc && !trackedMiroDocs.has(document.miroDoc))
    .map((document) => {
      // sweepInvoices.js's own mapping, so a row does not change shape under
      // the supplier at the moment it is finally recorded.
      const subTotal = Number(document.taxableAmount) || 0;
      const totalAmount = Number(document.grossAmount) || 0;
      return {
        id: document.miroDoc,
        sapOnly: true,
        invoiceNumber: document.miroDoc,
        // displayDate already reads SAP's YYYYMMDD, so it is passed through
        // rather than converted to a timestamp it never was.
        invoiceDate: document.docDate || null,
        sapMiroDoc: document.miroDoc,
        poId: poNumberOf(document) || '—',
        subTotal,
        taxAmount: Math.max(totalAmount - subTotal, 0),
        totalAmount,
        currency: document.currency || 'INR',
        // Deliberately not 'Submitted': this supplier submitted nothing, AP
        // posted it. The status column renders sapOnly rows on its own.
        status: null,
      };
    });

  const allInvoices = [...(submittedInvoices || []), ...sapOnlyInvoices];

  const columns = [
    {
      key: 'invoice',
      header: 'Your invoice',
      primary: true,
      // A sapOnly row has no invoice of the supplier's own — the document is
      // the buyer's, and it appears under their reference in the next column.
      // Repeating the MIRO number here would dress it up as something this
      // supplier raised.
      render: (inv) => (
        <div className="leading-tight">
          {inv.sapOnly ? (
            <span
              className="text-fg-muted"
              title="Your buyer's finance team has posted this invoice. It is not recorded in this portal yet, so there is nothing here to act on."
            >
              Not recorded here yet
            </span>
          ) : (
            <span className="mono text-fg">{inv.invoiceNumber}</span>
          )}
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
          {/* `Ref` is this portal's own record number; a sapOnly row has none
              — its id is the MIRO number, and printing it here would read as
              a second, portal-side reference that does not exist. */}
          {!inv.sapOnly && <span className="mono block text-xs text-fg-subtle">Ref {inv.id}</span>}
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
      // A sapOnly row has no portal status to report — the supplier submitted
      // nothing and there is no local record to carry one. Saying "Submitted"
      // would assert a step that never happened.
      render: (inv) => (inv.sapOnly
        ? <span className="text-fg-muted">Posted by your buyer</span>
        : <StatusBadge label={inv.status || 'Submitted'} variant={invoiceStatusVariant(inv.status)} />),
    },
    {
      key: 'confirmed',
      header: 'Confirmed',
      render: (inv) => (sapMiroStatus === 'error' ? (
        <span className="text-fg-muted" title="Could not reach your buyer's system to check this invoice. Nothing about the invoice has changed.">
          Could not check
        </span>
      ) : (sapMiroStatus === 'loading' || sapMiroDocuments === null) ? (
        <Spinner size={14} label="Checking with your buyer's system" />
      ) : inv.sapOnly ? (
        // This row came from that system — the question it answers is already
        // answered, and spinning or "not confirmed" would both be false.
        <span className="inline-flex items-center gap-1.5 text-success" title="This invoice is in the buyer's finance system">
          <CheckCircle2 className="size-4" strokeWidth={1.5} aria-hidden="true" /> Confirmed
        </span>
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
      {/* The MIRO read supplies both the not-yet-recorded rows merged into the
          table below and the per-row Confirmed badge. When it has not
          answered, say so once here rather than leaving a quietly short
          list — the same notice PurchaseOrdersView shows for its own ledger. */}
      {sapMiroStatus === 'error' && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-tint px-3 py-2.5 text-sm text-warning" role="status">
          <AlertCircle className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <p className="flex-1">
            Could not reach your buyer&rsquo;s records, so any invoice their finance team has
            posted that this portal has not recorded yet is missing from this list. Everything
            already tracked here is unaffected.
          </p>
          {retrySapMiroStatus && (
            <Button size="sm" variant="secondary" onClick={retrySapMiroStatus}>Try again</Button>
          )}
        </div>
      )}
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={allInvoices}
        rowLabel={(inv) => inv.invoiceNumber}
        empty="No invoices yet — once your buyer’s finance team posts an invoice against your delivery, it appears here."
      />
    </div>
  );
}
