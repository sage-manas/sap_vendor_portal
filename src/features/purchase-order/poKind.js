// What kind of purchase order this is, in SAP's own terms.
//
// The decisive field is the account assignment category on each line
// (EKPO-KNTTP, `ACC_ASSIGNMNT_CAT` in zpo_grn/Detail, mapped to
// `accountAssignmentCategory` by backend/sap/drivers/s4odata.driver.js):
//
//   'A'   asset procurement — capex, posts to a fixed asset (ANLN1/ANLN2)
//   'D'   service line
//   blank an ordinary material/stock line
//
// Invoicing is a separate axis, not a fourth kind: a line carries an invoicing
// plan when SAP gives it an `INV_PLANNO` (FPLA-FPLNR), and an order of any
// category may or may not have one. So a PO is described by a category *and*
// whether it is invoice-planned, never by one instead of the other.
//
// Per line, not per order, because SAP allows an order to mix them. An order
// is described by the categories its lines actually carry — `mixed` is a real
// answer, not a failure to decide.

export const CATEGORY_ASSET = 'A';
export const CATEGORY_SERVICE = 'D';
export const CATEGORY_COST_CENTRE = 'K';

const CATEGORIES = {
  [CATEGORY_ASSET]: {
    key: 'asset',
    label: 'Asset',
    orderLabel: 'Asset PO',
    hint: 'Capital expenditure: these lines post to a fixed asset in SAP, not to stock.',
  },
  [CATEGORY_SERVICE]: {
    key: 'service',
    label: 'Service',
    orderLabel: 'Service PO',
    hint: 'A service line — performance is recorded against the order rather than received into stock.',
  },
  // Present in the live ledger alongside A and D. 'K' is SAP's standard
  // cost-centre account assignment: consumed on receipt against a cost centre
  // instead of going into stock.
  [CATEGORY_COST_CENTRE]: {
    key: 'cost_centre',
    label: 'Cost centre',
    orderLabel: 'Cost centre PO',
    hint: 'Consumed against a cost centre rather than received into stock.',
  },
};

const STANDARD = {
  key: 'standard',
  label: 'Material',
  orderLabel: 'Standard PO',
  hint: 'An ordinary material order: goods are received into stock against it.',
};

const MIXED = {
  key: 'mixed',
  label: 'Mixed',
  orderLabel: 'Mixed PO',
  hint: 'This order carries lines of more than one account assignment category. Each line says which it is.',
};

/**
 * The category descriptor for one line. Never null — a blank category is the
 * standard kind.
 *
 * A category this file does not recognise is reported as itself rather than
 * quietly becoming "Material": SAP has more categories than the four seen here
 * (F order, P project, …), and calling one of them a stock line would be a
 * wrong answer where "category X, whatever that is" is a true one.
 */
export const lineKind = (item) => {
  const code = String(item?.accountAssignmentCategory || '').trim().toUpperCase();
  if (!code) return STANDARD;
  return CATEGORIES[code] || {
    key: 'other',
    label: code,
    orderLabel: `Category ${code} PO`,
    hint: `SAP account assignment category "${code}". This portal has no description for it.`,
  };
};

/**
 * The category descriptor for a whole order: whatever its lines agree on, or
 * `mixed` when they do not. An order with no lines reads as standard — there
 * is nothing to say otherwise.
 */
export const poKind = (po) => {
  const lines = (po?.items || []).filter(Boolean);
  if (!lines.length) return STANDARD;
  const [first, ...rest] = lines.map(lineKind);
  return rest.every(kind => kind.key === first.key) ? first : MIXED;
};

/**
 * The badge colour for a kind. Here rather than in the component because three
 * places render the same badge, and a kind added above must not come out
 * looking like a standard line in two of them because a ternary was missed.
 */
export const kindTone = (kind) => ({
  asset: 'border-violet-400/40 text-violet-500',
  service: 'border-sky-400/40 text-sky-500',
  cost_centre: 'border-indigo-400/40 text-indigo-500',
  other: 'border-slate-400/40 text-slate-500',
  mixed: 'border-amber-400/40 text-amber-500',
}[kind?.key] || 'border-border text-text-tertiary');

/**
 * Whether a line is invoiced against a plan rather than on receipt. Two
 * spellings, because they come from different places and mean the same thing:
 * `invoicePlan.enabled` on a plan the portal holds (db/poHelpers.js's
 * formatPlan), `invoicePlanNumber` on a line read straight from SAP.
 */
export const lineHasInvoicePlan = (item) =>
  Boolean(item?.invoicePlan?.enabled || item?.invoicePlanNumber);

/** Whether any line of this order is invoice-planned. */
export const hasInvoicePlan = (po) => (po?.items || []).some(lineHasInvoicePlan);

/**
 * Whether a supplier has proposed an invoicing-plan change on this order that
 * the buying organisation has not yet approved or rejected
 * (InvoicePlan.pendingChange — set by po.controller.js's
 * proposeInvoicePlanChange, cleared by approveInvoicePlanChange/
 * rejectInvoicePlanChange).
 *
 * The approve/reject action itself already lives in InvoicePlanPanel, but
 * that panel only renders once someone opens this specific order's invoice
 * plan tab — nothing on the PO list said a proposal was sitting there
 * waiting, so a client_admin had no way to know to look without already
 * knowing which order to check.
 */
export const hasPendingInvoicePlanChange = (po) =>
  (po?.items || []).some((item) => Boolean(item?.invoicePlan?.pendingChange));

/** The SAP plan numbers on this order, for display. Empty when none. */
export const invoicePlanNumbers = (po) => [...new Set(
  (po?.items || [])
    .map(item => item?.invoicePlanNumber || item?.invoicePlan?.planNumber)
    .filter(Boolean)
    .map(String),
)];
