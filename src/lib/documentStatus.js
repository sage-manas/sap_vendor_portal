// The document status groupings the UI filters on.
//
// A mirror of `backend/config/statuses.js`, not a second opinion: the backend
// registry is the source, and `src/lib/documentStatus.test.js` reads that file
// and fails if these lists drift from it. The copy exists because these are
// used in render — a filter that needs a network round trip before it can
// decide what "still open" means is a worse bug than the one this replaces.
//
// Why there is a registry at all (issue #283): every screen used to write
// `status !== 'Cleared'` inline, which counts a *Rejected* invoice as money
// the buyer still owes. Figures aggregated on the server now come from
// GET /api/dashboard/summary (issue #280) and apply these same groupings
// there; what is left here is per-row presentation.

export const INVOICE_STATUS = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  MATCH_WARNING: 'Match Warning',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  POSTED_IN_SAP: 'Posted in SAP',
  CLEARED: 'Cleared',
};

export const INVOICE_STATUSES = Object.values(INVOICE_STATUS);

/** In the buyer's hands and still owed. Rejected is not owed. */
export const INVOICE_OPEN = [
  INVOICE_STATUS.SUBMITTED,
  INVOICE_STATUS.UNDER_REVIEW,
  INVOICE_STATUS.MATCH_WARNING,
  INVOICE_STATUS.APPROVED,
  INVOICE_STATUS.POSTED_IN_SAP,
];

/** Decided, either way. */
export const INVOICE_TERMINAL = [INVOICE_STATUS.CLEARED, INVOICE_STATUS.REJECTED];

export const isInvoiceOpen = (status) => INVOICE_OPEN.includes(status);

export const PO_STATUS = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  INVOICED: 'Invoiced',
  PAID: 'Paid',
};

export const PO_STATUSES = Object.values(PO_STATUS);

/** The supplier still owes an action on the order itself — "Awaiting you". */
export const PO_AWAITING_SUPPLIER = [PO_STATUS.OPEN, PO_STATUS.ACKNOWLEDGED];

/** Shipped, nothing left to do on the order, not yet billed. */
export const PO_IN_FLIGHT = [PO_STATUS.DISPATCHED, PO_STATUS.DELIVERED];

/** Ordered and not yet billed — "Not yet invoiced" (issue #288). */
export const PO_NOT_INVOICED = [...PO_AWAITING_SUPPLIER, ...PO_IN_FLIGHT];

/** Billed. What is still owed is an invoice question, not an order one. */
export const PO_CLOSED = [PO_STATUS.INVOICED, PO_STATUS.PAID];
