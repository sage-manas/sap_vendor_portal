// One status vocabulary for every surface: PO, GRN/ASN, invoice, payment, RFQ,
// bid, vendor approval, tenant, user, invitation and SAP sync.
//
// Tone answers "what does the reader need to do about it", not "is it good":
//
//   action   — waiting on *this* reader (accent fill)
//   warn     — something is off and needs a look (warning fill)
//   danger   — failed / refused / overdue (danger fill)
//   progress — moving, nobody needs to act yet (info dot)
//   done     — finished successfully (success dot)
//   neutral  — at rest, not started (grey dot)
//   ended    — closed without completing; no longer relevant (hollow dot)
//
// Only the first three get a filled background — the rest are a dot and a
// word, so a table full of healthy rows stays quiet.

export const TONE_CLASS = {
  action: 'status-badge-action',
  warn: 'status-badge-warn',
  danger: 'status-badge-suspended',
  progress: 'status-badge-info',
  done: 'status-badge-active',
  neutral: 'status-badge-pending',
  ended: 'status-badge-revoked',
};

// Legacy `variant` names (src/lib/statusColors.js, console/primitives) → tone,
// for labels the map below does not know.
export const VARIANT_TONE = {
  active: 'done',
  info: 'progress',
  cooling: 'progress',
  pending: 'neutral',
  trial: 'progress',
  warn: 'warn',
  suspended: 'danger',
  revoked: 'ended',
  action: 'action',
};

const T = {
  // Purchase orders (PoStatus), and the supplier PO page's own labels for them
  open: 'action', // a new order is the supplier's to acknowledge
  new: 'action',
  'shipment sent': 'progress',
  'delivery confirmed': 'done',
  'invoice posted': 'done',
  acknowledged: 'progress',
  dispatched: 'progress',
  'in transit': 'progress',
  delivered: 'done',
  invoiced: 'done',
  paid: 'done',
  cancelled: 'ended',
  blocked: 'danger',

  // Goods receipt / quality
  'qc passed': 'done',
  'qc pass': 'done',
  'qc discrepancy': 'danger',
  'qc fail': 'danger',

  // Invoices
  submitted: 'progress',
  parked: 'progress',
  posted: 'progress',
  'match warning': 'warn',
  'match error': 'danger',
  cleared: 'done',
  uncleared: 'warn',
  overdue: 'danger',

  // Payments / TDS / MSME
  processing: 'progress',
  available: 'done',
  'filed & signed': 'done',
  safe: 'done',
  'critical (45-day alert)': 'warn',
  'overdue (msme priority!)': 'danger',

  // RFQs and bids
  draft: 'neutral',
  published: 'progress',
  'bidding open': 'action',
  quoted: 'progress',
  'under evaluation': 'progress',
  awarded: 'done',
  accepted: 'done',
  closed: 'ended',
  lost: 'ended',
  withdrawn: 'ended',

  // Supplier approval (VENDOR_STATUS)
  pending: 'neutral',
  'pending approval': 'action',
  'under review': 'action',
  approved: 'done',
  rejected: 'danger',

  // Tenants, users, invitations
  trial: 'progress',
  active: 'done',
  suspended: 'danger',
  terminated: 'ended',
  invited: 'neutral',
  revoked: 'ended',
  expired: 'ended',

  // SAP sync (SAP_SYNC_STATE) and health
  local: 'neutral',
  synced: 'done',
  failed: 'danger',
  orphaned: 'danger',
  needs_manual_match: 'warn',
  'needs manual match': 'warn',
  healthy: 'done',
  degraded: 'warn',
  failing: 'danger',
  unknown: 'neutral',
  success: 'done',
};

/** The tone for a domain status label, or null when the label is not known. */
export const toneFor = (label) => {
  if (label == null) return null;
  return T[String(label).trim().toLowerCase()] || null;
};

/** The badge class for a label, falling back to a legacy variant name. */
export const statusClass = (label, variant, tone) =>
  TONE_CLASS[tone] || TONE_CLASS[toneFor(label)] || TONE_CLASS[VARIANT_TONE[variant]] || TONE_CLASS.neutral;
