import React from 'react';
import { Receipt, Landmark, ShieldCheck, ShieldAlert, Loader2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import { invoiceStatusVariant } from '@/lib/statusColors';

// 13 Sept 2026 — documents arrive with ISO timestamps; nobody reads those.
const displayDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
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

  return (
    <div className="space-y-6 max-w-full mx-auto animate-fade-in pb-12">
      {/* Title Header */}
      <div className="card p-4 flex items-center justify-between">
        <div>
          <h2 className="page-title flex items-center gap-2">
            <Receipt className="size-4.5 text-text-secondary" /> Invoices
          </h2>
          <p className="text-[11px] text-text-tertiary mt-1 font-semibold">
            Invoices your buyer's finance team has posted, and whether they've been confirmed and paid
          </p>
        </div>
      </div>

      {/* INVOICE REGISTRY */}
      <div className="space-y-3 pt-4">
        <h3 className="label">
          Invoices
        </h3>

        {submittedInvoices.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={Landmark}
              title="No invoices yet"
              description="Once your buyer's finance team posts an invoice against your delivery, it will appear here."
            />
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left table-sticky">
              <thead>
                <tr>
                  <th>Your invoice</th>
                  <th>Buyer&apos;s reference</th>
                  <th>Order</th>
                  <th className="text-right">GST Invoice Value (18%)</th>
                  <th className="text-center">Status</th>
                  <th className="text-center">Confirmed</th>
                  <th>Payment details</th>
                </tr>
              </thead>
              <tbody>
                {submittedInvoices.map(inv => {
                const paymentDetail = sapPaymentDetails[inv.sapMiroDoc];
                return (
                  <tr key={inv.id}>
                    <td>
                      <p className="font-bold text-text-primary uppercase font-mono">{inv.invoiceNumber}</p>
                      <p className="text-[10px] text-text-tertiary font-mono mt-0.5">Date: {displayDate(inv.invoiceDate)}</p>
                    </td>
                    <td className="font-mono">
                      {/* The portal posts nothing to SAP: this number exists
                          only once AP has posted the invoice and the
                          reconciliation has recognised it. */}
                      <p className={inv.sapMiroDoc ? 'text-text-primary font-bold' : 'text-text-tertiary'}>
                        {inv.sapMiroDoc ? inv.sapMiroDoc : 'Awaiting the buyer’s finance team'}
                      </p>
                      <p className="text-[9px] text-text-tertiary mt-0.5">Ref: {inv.id}</p>
                    </td>
                    <td className="font-mono font-bold text-text-secondary">
                      {inv.poId}
                    </td>
                    <td className="text-right font-mono font-bold text-text-primary tabular-nums">
                      ₹ {Number(inv.totalAmount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="text-center">
                      <StatusBadge label={inv.status || 'Submitted'} variant={invoiceStatusVariant(inv.status)} />
                    </td>
                    <td className="text-center">
                      {sapMiroDocuments === null ? (
                        <Loader2 className="size-3.5 animate-spin text-text-tertiary inline-block" />
                      ) : isConfirmedInSap(inv) ? (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400" title="The buyer’s finance system confirms this invoice">
                          <ShieldCheck className="size-3.5" /> Confirmed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-amber-400" title="The buyer’s finance team has not recorded this invoice yet">
                          <ShieldAlert className="size-3.5" /> Not confirmed yet
                        </span>
                      )}
                    </td>
                    <td>
                      {paymentDetail ? (
                        <div className="text-[10px] font-mono leading-relaxed">
                          <p className="text-text-primary font-bold">
                            {paymentDetail.status} · Net ₹{Number(paymentDetail.netDisbursed).toLocaleString('en-IN')}
                          </p>
                          <p className="text-text-tertiary">
                            TDS ₹{Number(paymentDetail.tdsDeducted).toLocaleString('en-IN')} · Paid on {displayDate(paymentDetail.clearingDate)}
                          </p>
                          {paymentDetail.utrReference && (
                            <p className="text-text-tertiary">UTR: {paymentDetail.utrReference}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-text-tertiary">
                          {isConfirmedInSap(inv) ? 'Not yet cleared' : '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
