import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';
import TableSkeleton from '@/components/ui/TableSkeleton';
import { invoiceStatusVariant } from '@/lib/statusColors';
import { Receipt, RefreshCw, Download } from 'lucide-react';
import ErrorBoundary from '@/components/ErrorBoundary';

export default function InvoicesView({
  state, selectedGrnId, setSelectedGrnId, invoiceForm, setInvoiceForm, handleInvoiceSubmit, isSubmitting
}) {
  const [isLoading, setIsLoading] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  const uninvoicedGRNs = (state?.grns || []).filter(g => !g.invoiceSubmitted);
  const submittedInvoices = state?.invoices || [];

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
      <div className="space-y-8 max-w-6xl animate-fade-in">
      <div>
        <h2 className="page-title">Invoice Submission</h2>
        <p className="text-text-tertiary text-xs mt-0.5">Submit invoices against delivery receipts your buyer has confirmed.</p>
      </div>

      {/* UNINVOICED BILLING ITEMS */}
      <div className="space-y-3">
        <h3 className="label">Ready to invoice</h3>
        {uninvoicedGRNs.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={Receipt}
              title="No delivery receipts waiting"
              description="Ship an order and wait for the buyer to confirm delivery before invoicing."
            />
          </div>
        ) : (
          <div className="space-y-3">
            {uninvoicedGRNs.map(grn => (
              <div key={grn.id} className="card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-text-primary font-mono">{grn.id}</span>
                    <span className="text-[10px] text-text-tertiary font-mono">(Receipt no: {grn.sapMigoDoc})</span>
                    {grn.items.some(i => i.rejectedQuantity > 0) && (
                      <StatusBadge label="Some items rejected" variant="suspended" />
                    )}
                  </div>
                  <div className="flex items-center gap-4 text-[10px] text-text-tertiary mt-1">
                    <span>Order: {grn.poId}</span>
                    <span>•</span>
                    <span>Received on: {grn.postingDate}</span>
                    <span>•</span>
                    <span>Received by: {grn.receivedBy}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    onClick={() => setSelectedGrnId(selectedGrnId === grn.id ? null : grn.id)}
                    variant="default"
                    size="sm"
                  >
                    Create invoice
                  </Button>
                </div>

                {/* EXPANDED MATCHING FORM */}
                {selectedGrnId === grn.id && (
                  <div className="w-full mt-4 p-4 rounded-none border border-border bg-surface2 space-y-4 sm:col-span-2 animate-slide-down order-last">
                    <h4 className="text-xs font-bold text-text-primary uppercase tracking-wider border-b border-border pb-2 flex items-center gap-2">
                      <Receipt className="size-4 text-emerald-text" /> Check the order, delivery, and invoice agree
                    </h4>

                    {/* DELIVERY RECEIPT ITEM LISTING */}
                    <div className="border border-border rounded-none overflow-x-auto">
                      <table className="w-full text-left table-sticky">
                        <thead>
                          <tr>
                            <th>Item description</th>
                            <th className="text-right">Received qty</th>
                            <th className="text-right">Accepted qty</th>
                            <th className="text-right">Rejected qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {grn.items.map(item => (
                            <tr key={item.line}>
                              <td>
                                <p className="font-semibold text-text-primary">{item.description}</p>
                                <p className="text-[9px] text-text-tertiary font-mono">{item.materialCode}</p>
                              </td>
                              <td className="text-right font-mono tabular-nums">{item.receivedQuantity}</td>
                              <td className="text-right font-mono text-emerald-400 font-bold tabular-nums">{item.acceptedQuantity}</td>
                              <td className="text-right font-mono text-rose-400 font-semibold tabular-nums">{item.rejectedQuantity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* INPUTS */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <label className="label">Your invoice number *</label>
                        <input
                          type="text" required maxLength={16} placeholder="TAX-2026-INV-1092"
                          value={invoiceForm.invoiceNumber}
                          onChange={e => setInvoiceForm({ ...invoiceForm, invoiceNumber: e.target.value })}
                          className="font-mono uppercase w-[20ch]"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="label">Invoice date *</label>
                        <input
                          type="date" required value={invoiceForm.invoiceDate}
                          onChange={e => setInvoiceForm({ ...invoiceForm, invoiceDate: e.target.value })}
                          className="w-[15ch] font-mono tabular-nums"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                      <Button onClick={() => setSelectedGrnId(null)} variant="ghost" size="sm">
                        Cancel
                      </Button>
                      <Button
                        disabled={isSubmitting}
                        onClick={() => handleInvoiceSubmit(grn)}
                        variant="default"
                        size="sm"
                      >
                        {isSubmitting ? (
                          <>
                            <RefreshCw className="size-3.5 animate-spin" /> Checking your invoice...
                          </>
                        ) : (
                          'Submit invoice'
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* BILLING ARCHIVE */}
      <div className="space-y-3">
        <h3 className="label">Submitted invoices</h3>
        {submittedInvoices.length === 0 ? (
          <div className="card">
            <EmptyState title="No invoices submitted yet" />
          </div>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-left table-sticky">
              <thead>
                <tr>
                  <th>Your invoice</th>
                  <th>Buyer&apos;s reference</th>
                  <th>Order</th>
                  <th className="text-right">GST Total (18%)</th>
                  <th className="text-center">Status</th>
                  <th className="text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {submittedInvoices.map(inv => (
                  <tr key={inv.id}>
                    <td>
                      <p className="font-semibold text-text-primary uppercase font-mono">{inv.invoiceNumber}</p>
                      <p className="text-[10px] text-text-tertiary mt-0.5">Date: {inv.invoiceDate}</p>
                    </td>
                    <td className="font-mono">
                      <p className="text-text-primary font-bold">{inv.sapMiroDoc}</p>
                      <p className="text-[9px] text-text-tertiary">Ref: {inv.id}</p>
                    </td>
                    <td className="font-mono">{inv.poId}</td>
                    <td className="text-right font-mono text-text-primary font-bold tabular-nums">₹{inv.totalAmount.toLocaleString()}</td>
                    <td className="text-center">
                      <StatusBadge
                        label={inv.status === 'Paid' ? 'Paid' : 'Submitted'}
                        variant={invoiceStatusVariant(inv.status)}
                      />
                    </td>
                    <td className="text-center">
                      <button
                        onClick={() => window.open(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'}/reports/invoice/${inv.id}`, '_blank')}
                        className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface2 transition-colors duration-150 rounded cursor-pointer"
                        title="Download Invoice PDF"
                      >
                        <Download className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </ErrorBoundary>
  );
}
