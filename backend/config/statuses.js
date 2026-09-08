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
};

const SAP_SYNC_STATES = Object.values(SAP_SYNC_STATE);

// Legal transitions, keyed on the FROM state. `synced` is terminal — once SAP
// has genuinely answered, nothing un-answers it. `local` only ever becomes
// `pending` (a document that was portal-only starts being watched); nothing
// leaves `local` any other way, and nothing re-enters it.
const SAP_SYNC_TRANSITIONS = {
  [SAP_SYNC_STATE.LOCAL]: [SAP_SYNC_STATE.PENDING],
  [SAP_SYNC_STATE.PENDING]: [SAP_SYNC_STATE.SYNCED, SAP_SYNC_STATE.FAILED, SAP_SYNC_STATE.ORPHANED],
  [SAP_SYNC_STATE.FAILED]: [SAP_SYNC_STATE.PENDING, SAP_SYNC_STATE.SYNCED],
  [SAP_SYNC_STATE.ORPHANED]: [SAP_SYNC_STATE.PENDING, SAP_SYNC_STATE.SYNCED],
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
  SAP_SYNC_STATE,
  SAP_SYNC_STATES,
  SAP_SYNC_TRANSITIONS,
  isLegalSyncTransition,
};
