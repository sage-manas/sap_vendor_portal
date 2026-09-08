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

module.exports = {
  VENDOR_STATUS,
  VENDOR_STATUSES,
  VENDOR_AWAITING_DECISION,
  VENDOR_IN_ONBOARDING,
  VENDOR_PRE_SUBMISSION,
  isVendorStatus,
};
