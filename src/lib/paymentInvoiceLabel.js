// "Which invoice(s) did this payment settle?" — the one answer every screen
// showing a payment needs, in one place (issue #282).
//
// Since #63 a Payment is a remittance header with one PaymentItem per settled
// invoice; the header itself has no invoiceId/invoiceNumber. Screens that
// still read those header fields showed a permanently blank reference. The
// backend now derives `invoiceRefs` (see backend/db/paymentHelpers.js) and
// this renders it; `items` is accepted too, so a payment that came from an
// endpoint or fixture without the derived field still names its invoices.
//
// Truncation matches the Overview's `listIds` — first three, then `+n` — so a
// remittance covering a whole F110 run stays one line.
const MAX_SHOWN = 3;

export const paymentInvoiceRefs = (payment) => {
  if (!payment) return [];
  if (Array.isArray(payment.invoiceRefs)) return payment.invoiceRefs.filter(Boolean);
  if (Array.isArray(payment.items)) {
    return payment.items.map((item) => item.invoiceNumber || item.invoiceId).filter(Boolean);
  }
  return [];
};

// Returns '' — not a placeholder — when nothing is known, so each caller
// keeps its own idea of how an unknown reads ('—', or omitting the line).
export const paymentInvoiceLabel = (payment) => {
  const refs = paymentInvoiceRefs(payment);
  if (!refs.length) return '';
  const shown = refs.slice(0, MAX_SHOWN).join(', ');
  return refs.length > MAX_SHOWN ? `${shown} +${refs.length - MAX_SHOWN}` : shown;
};
