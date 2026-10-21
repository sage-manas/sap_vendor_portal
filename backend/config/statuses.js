// The status registry.
//
// A status list written inline is a list that drifts: the model's enum, the
// directory's filter dropdown and the overview's counts each end up with their
// own idea of what "in review" means. They read from here instead.
//
// Phase 5 covers the supplier lifecycle, which is the one the tenant workspace
// acts on. Sourcing and finance statuses join this file when a phase needs
// them in more than one place.

const VENDOR_STATUS = {
  DRAFT: 'Draft',
  PENDING: 'Pending',
  PENDING_APPROVAL: 'Pending Approval',
  UNDER_REVIEW: 'Under Review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const VENDOR_STATUSES = Object.values(VENDOR_STATUS);

// Submitted and waiting on a human: what the directory's approval queue holds
// and what the SLA in config/tenantSettings.js is measured against.
const VENDOR_AWAITING_DECISION = [VENDOR_STATUS.UNDER_REVIEW, VENDOR_STATUS.PENDING_APPROVAL];

// Onboarding is not finished and no one is waiting on us.
const VENDOR_IN_ONBOARDING = [VENDOR_STATUS.DRAFT, VENDOR_STATUS.PENDING];

// The supplier still owes us a submission, so the transacting modules are not
// theirs yet — see middleware/requireOnboarded.js. Distinct from
// VENDOR_IN_ONBOARDING because Rejected belongs here (they are back to fixing
// their registration) but not there (a rejection is a decision, not a queue).
// A supplier merely *awaiting* a decision has done their part and is let in.
const VENDOR_PRE_SUBMISSION = [
  VENDOR_STATUS.DRAFT,
  VENDOR_STATUS.PENDING,
  VENDOR_STATUS.REJECTED,
];

const isVendorStatus = (value) => VENDOR_STATUSES.includes(value);

// --- Invoice ---------------------------------------------------------------
//
// Invoice.status is a plain String column, not a Prisma enum (several values
// are multi-word) — so this file is the only thing that can keep the
// validator, the overview's counts and the supplier's own ageing buckets
// agreeing on what "not yet paid" means. They used to each write their own
// list, and `status !== 'Cleared'` counted a *Rejected* invoice as money the
// buyer still owed (issue #283).
const INVOICE_STATUS = {
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under Review',
  MATCH_WARNING: 'Match Warning',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  POSTED_IN_SAP: 'Posted in SAP',
  CLEARED: 'Cleared',
};

const INVOICE_STATUSES = Object.values(INVOICE_STATUS);

// In the buyer's hands and still owed: what an outstanding total, an ageing
// bucket and the MSME 45-day clock are measured over. Rejected is not here —
// a rejection is a decision, and a rejected invoice is not a receivable.
const INVOICE_OPEN = [
  INVOICE_STATUS.SUBMITTED,
  INVOICE_STATUS.UNDER_REVIEW,
  INVOICE_STATUS.MATCH_WARNING,
  INVOICE_STATUS.APPROVED,
  INVOICE_STATUS.POSTED_IN_SAP,
];

// Decided, either way. Nothing further is expected to happen to these.
const INVOICE_TERMINAL = [INVOICE_STATUS.CLEARED, INVOICE_STATUS.REJECTED];

const isInvoiceStatus = (value) => INVOICE_STATUSES.includes(value);

// --- Purchase order --------------------------------------------------------
//
// PoStatus *is* a Prisma enum (prisma/schema.prisma), so the values are
// enforced by the column. What drifted were the groupings: the supplier's
// Overview counted Open+Acknowledged as "open orders" while the same
// supplier's Reports page counted those plus Dispatched+Delivered, and
// neither said so — so one supplier read two different "Open orders"
// numbers on two tabs of the same portal (issue #288). Both meanings are
// legitimate and they are different questions, so both are named here, and
// the screens label them by what they mean ("Awaiting you", "Not yet
// invoiced") rather than both claiming the word "open".
//
// There is deliberately no `Cancelled` here. Reports used to filter on one,
// which matched nothing: an order SAP no longer lists is marked with
// `sapDeletedAt`, not moved to a status (jobs/handlers/sweepPurchaseOrders.js,
// `markDeletedOrders`). Cancellation is a column, not a status, and the dead
// filter is gone.
const PO_STATUS = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Acknowledged',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  INVOICED: 'Invoiced',
  PAID: 'Paid',
};

const PO_STATUSES = Object.values(PO_STATUS);

// The supplier still owes the buyer an action on the order itself: to
// acknowledge it, or to ship it. Labelled "Awaiting you" on screen.
const PO_AWAITING_SUPPLIER = [PO_STATUS.OPEN, PO_STATUS.ACKNOWLEDGED];

// Shipped and out of the supplier's hands, but not yet billed — nothing to
// do on the order itself, and no invoice against it either.
const PO_IN_FLIGHT = [PO_STATUS.DISPATCHED, PO_STATUS.DELIVERED];

// Ordered and not yet billed — the value still to be invoiced on the
// account, which is the union of the two groups above. Labelled "Not yet
// invoiced" on screen, because that is the question it answers.
const PO_NOT_INVOICED = [...PO_AWAITING_SUPPLIER, ...PO_IN_FLIGHT];

// Billed. The order has left the supplier's working set; what is still owed
// against it is an invoice question (INVOICE_OPEN), not an order one.
const PO_CLOSED = [PO_STATUS.INVOICED, PO_STATUS.PAID];

// --- RFQ --------------------------------------------------------------------
//
// RFQ.status is a plain String column too. Here for the reason the header
// gives — more than one place needs it: the workspace overview counts "RFQs
// open for bidding" and "RFQs awarded", and the RFQ list's own filter now
// offers the same two as the tiles that link to it (issue #281). A tile and
// the list behind it disagreeing about a status is the bug that makes a
// clicked-through count change on arrival.
const RFQ_STATUS = {
  BIDDING_OPEN: 'Bidding Open',
  AWARDED: 'Awarded',
  CLOSED: 'Closed',
};

// Dual identity / sync state — Phase 3 of docs/04-sap-runtime-engineering-plan.md.
// Every one of RFQ/PurchaseOrder/ASN/GRN/Invoice/Payment carries a
// `sapSyncState` column with this value set (prisma/schema.prisma), read
// uniformly by the reconciliation queue regardless of which of the six it is.
//
// `local` is a *success* state, not a deficiency: a portal-internal RFQ never
// becomes anything else, and that is the honest answer — see the note on
// RFQ.sapSyncState in schema.prisma for why sourcing never leaves it.
const SAP_SYNC_STATE = {
  LOCAL: 'local',       // portal-internal by design; SAP will never hold it
  PENDING: 'pending',   // waiting for SAP to produce or acknowledge
  SYNCED: 'synced',     // correlated to a real SAP document number
  FAILED: 'failed',     // SAP rejected it, or the watching job errored
  ORPHANED: 'orphaned', // watched past maxAttempts; SAP never produced it
  // More than one SAP document fits the match key equally well (issue #64 —
  // a periodic invoicing plan bills the same PO/amount every period, so the
  // second invoice onward always has a same-amount sibling in SAP's ledger).
  // This is not "SAP never answered" (orphaned) or "the job errored"
  // (failed) — SAP answered fine, the ambiguity is in the portal's own match
  // key. Parked here instead of retried into the ground; a human resolves it
  // via the reconciliation queue.
  NEEDS_MANUAL_MATCH: 'needs_manual_match',
};

const SAP_SYNC_STATES = Object.values(SAP_SYNC_STATE);

// Legal transitions, keyed on the FROM state. `synced` is terminal — once SAP
// has genuinely answered, nothing un-answers it. `local` only ever becomes
// `pending` (a document that was portal-only starts being watched); nothing
// leaves `local` any other way, and nothing re-enters it.
const SAP_SYNC_TRANSITIONS = {
  [SAP_SYNC_STATE.LOCAL]: [SAP_SYNC_STATE.PENDING],
  [SAP_SYNC_STATE.PENDING]: [
    SAP_SYNC_STATE.SYNCED, SAP_SYNC_STATE.FAILED, SAP_SYNC_STATE.ORPHANED, SAP_SYNC_STATE.NEEDS_MANUAL_MATCH,
  ],
  [SAP_SYNC_STATE.FAILED]: [SAP_SYNC_STATE.PENDING, SAP_SYNC_STATE.SYNCED],
  [SAP_SYNC_STATE.ORPHANED]: [SAP_SYNC_STATE.PENDING, SAP_SYNC_STATE.SYNCED],
  // A human resolves the ambiguity by retrying the watch (which re-matches
  // from scratch) or, if SAP itself later disambiguates it (e.g. only one
  // candidate is still open), the next attempt reaching `synced` directly.
  [SAP_SYNC_STATE.NEEDS_MANUAL_MATCH]: [SAP_SYNC_STATE.PENDING, SAP_SYNC_STATE.SYNCED],
  [SAP_SYNC_STATE.SYNCED]: [],
};

// A no-op "transition" (from === to) is always legal — re-asserting the
// current state is not a state change.
const isLegalSyncTransition = (from, to) => from === to || (SAP_SYNC_TRANSITIONS[from] || []).includes(to);

module.exports = {
  VENDOR_STATUS,
  VENDOR_STATUSES,
  VENDOR_AWAITING_DECISION,
  VENDOR_IN_ONBOARDING,
  VENDOR_PRE_SUBMISSION,
  isVendorStatus,
  INVOICE_STATUS,
  INVOICE_STATUSES,
  INVOICE_OPEN,
  INVOICE_TERMINAL,
  isInvoiceStatus,
  PO_STATUS,
  PO_STATUSES,
  PO_AWAITING_SUPPLIER,
  PO_IN_FLIGHT,
  PO_NOT_INVOICED,
  PO_CLOSED,
  RFQ_STATUS,
  SAP_SYNC_STATE,
  SAP_SYNC_STATES,
  SAP_SYNC_TRANSITIONS,
  isLegalSyncTransition,
};
