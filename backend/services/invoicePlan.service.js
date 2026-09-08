// Invoicing plans for purchase order line items — the arithmetic and the rules,
// with no database and no HTTP in sight.
//
// SAP models this as an FPLA header per PO item with FPLT date lines under it
// (see models/PurchaseOrder.js for the field-by-field mapping). The two plan
// types are genuinely different calculations, and conflating them is the classic
// way to get an invoicing plan wrong:
//
//   Periodic — the item's value is what gets invoiced EACH period. A 50,000/mo
//              retainer over a year is twelve 50,000 invoices, total 600,000.
//              The dates are generated from start/end/frequency.
//
//   Partial  — the item's value is SPLIT across the dates. A 600,000 machine on
//              a 30/40/30 milestone schedule is three invoices totalling
//              600,000. The dates are stated, never generated, and the split
//              must reconcile to the item value exactly.
//
// Everything here is pure, so the periodic date generation and the partial
// reconciliation can be tested without a PO, a tenant or a SAP connection.

const FREQUENCY_STEPS = {
  Weekly:        { days: 7 },
  Monthly:       { months: 1 },
  Quarterly:     { months: 3 },
  'Half-Yearly': { months: 6 },
  Yearly:        { months: 12 },
};

const PLAN_TYPES = ['Periodic', 'Partial'];
const INVOICING_RULES = ['Advance', 'Arrears'];

// A plan line can only be invoiced when SAP would let one be posted against it:
// its settlement date has arrived, it carries no billing block, and nothing has
// been invoiced against it yet.
const LINE_OPEN = 'Open';

class InvoicePlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvoicePlanError';
    this.code = 'invalid_invoice_plan';
    this.statusCode = 400;
  }
}

/** Midnight UTC for a date-only value, so a plan generated in IST and one read
 *  back in UTC produce the same settlement dates. */
const atUtcMidnight = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new InvoicePlanError(`Invalid date: ${value}`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

/**
 * Adds whole months, clamping to the end of the target month rather than
 * rolling over. 31 Jan + 1 month is 28/29 Feb, not 2/3 March — SAP's own
 * behaviour, and the difference between a plan with twelve monthly dates and one
 * whose dates drift a day later every month.
 */
const addMonths = (date, months) => {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTarget)));
};

const addDays = (date, days) => new Date(date.getTime() + days * 86400000);

/**
 * The start of the `count`-th period, always measured from the plan's own start
 * date rather than from the previous period.
 *
 * This anchoring matters. Stepping month by month, a plan starting 31 January
 * clamps to 28 February and then never climbs back — March becomes the 28th,
 * April the 28th, and a twelve-month plan quietly grows a thirteenth stub
 * period. Measured from the start, the same plan is 31 Jan, 28 Feb, 31 Mar, 30
 * Apr … which is what SAP generates and what the contract says.
 */
const periodStartAt = (start, frequency, count) => {
  const step = FREQUENCY_STEPS[frequency];
  if (!step) throw new InvoicePlanError(`Unknown invoicing frequency "${frequency}"`);
  return step.days ? addDays(start, step.days * count) : addMonths(start, step.months * count);
};

// Money is compared, never accumulated, at two decimals: a 1/3 split of 100
// must still reconcile to 100 rather than to 99.99.
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const TOLERANCE = 0.01;

// A plan longer than this is a data-entry mistake, not a schedule — a weekly
// plan with the end date typed as 2099 would otherwise generate 4,000 lines and
// a 2MB purchase order document.
const MAX_PLAN_LINES = 240;

/**
 * Expands a periodic plan into its settlement dates.
 *
 * Each period runs [periodStart, nextPeriodStart). Invoicing in arrears settles
 * on the last day of the period, in advance on its first — the SAP FAKKO
 * distinction, and the reason a "monthly from 1 Jan to 31 Dec" plan can settle
 * either on the 1st or on the 31st.
 */
const generatePeriodicLines = ({ startDate, endDate, frequency, periodicAmount, invoicingRule = 'Arrears' }) => {
  const start = atUtcMidnight(startDate);
  const end = atUtcMidnight(endDate);
  if (end <= start) throw new InvoicePlanError('The invoicing plan end date must be after its start date');
  if (!(periodicAmount > 0)) throw new InvoicePlanError('A periodic invoicing plan needs a positive amount per period');

  const lines = [];
  let periodStart = start;

  while (periodStart < end) {
    const nextStart = periodStartAt(start, frequency, lines.length + 1);
    if (nextStart <= periodStart) throw new InvoicePlanError(`Invoicing frequency "${frequency}" does not advance the date`);

    // A trailing stub shorter than a full period is still a period SAP would
    // invoice — a plan ending mid-month bills that part-month rather than
    // silently dropping it.
    const periodEnd = nextStart > end ? end : addDays(nextStart, -1);
    const settlementDate = invoicingRule === 'Advance' ? periodStart : periodEnd;

    lines.push({
      lineNumber: (lines.length + 1) * 10,
      settlementDate,
      billingDate: settlementDate,
      percentage: 0,
      amount: round2(periodicAmount),
      status: LINE_OPEN,
      blocked: false,
      description: `${frequency} charge ${settlementDate.toISOString().slice(0, 10)}`,
    });

    if (lines.length > MAX_PLAN_LINES) {
      throw new InvoicePlanError(`A ${frequency.toLowerCase()} plan over this date range would need more than ${MAX_PLAN_LINES} invoicing dates — shorten the range or use a longer frequency`);
    }
    periodStart = nextStart;
  }

  if (!lines.length) throw new InvoicePlanError('The invoicing plan date range is too short to produce a single period');
  return lines;
};

/**
 * Normalises a partial plan's stated milestones and checks they reconcile to the
 * line item's net value.
 *
 * A milestone may be given as a percentage or as an amount; whichever is missing
 * is derived from `itemNetValue`. Rounding is absorbed by the LAST milestone, so
 * three 33.33% instalments of 100 come to 33.33 / 33.33 / 33.34 and the plan
 * still totals the item — never 99.99, which is an invoice SAP would block.
 */
const buildPartialLines = ({ milestones, itemNetValue }) => {
  if (!Array.isArray(milestones) || !milestones.length) {
    throw new InvoicePlanError('A partial invoicing plan needs at least one instalment');
  }
  if (!(itemNetValue > 0)) {
    throw new InvoicePlanError('A partial invoicing plan needs a line item with a positive net value to split');
  }

  const sorted = [...milestones].sort(
    (a, b) => atUtcMidnight(a.settlementDate) - atUtcMidnight(b.settlementDate),
  );

  const lines = sorted.map((milestone, index) => {
    const hasAmount = milestone.amount !== undefined && milestone.amount !== null && milestone.amount !== '';
    const hasPercentage = milestone.percentage !== undefined && milestone.percentage !== null && milestone.percentage !== '';
    if (!hasAmount && !hasPercentage) {
      throw new InvoicePlanError(`Instalment ${index + 1} needs either an amount or a percentage`);
    }

    const amount = hasAmount ? Number(milestone.amount) : round2((Number(milestone.percentage) / 100) * itemNetValue);
    const percentage = hasPercentage ? Number(milestone.percentage) : round2((amount / itemNetValue) * 100);
    if (!(amount > 0)) throw new InvoicePlanError(`Instalment ${index + 1} must be for a positive amount`);

    const settlementDate = atUtcMidnight(milestone.settlementDate);
    return {
      lineNumber: (index + 1) * 10,
      description: milestone.description || `Instalment ${index + 1}`,
      settlementDate,
      billingDate: settlementDate,
      percentage: round2(percentage),
      amount: round2(amount),
      status: LINE_OPEN,
      blocked: Boolean(milestone.blocked),
    };
  });

  // Absorb the rounding remainder into the final instalment before checking, so
  // a legitimate split is not rejected for being a paisa short of the item.
  const total = round2(lines.reduce((sum, line) => sum + line.amount, 0));
  const remainder = round2(itemNetValue - total);
  if (Math.abs(remainder) > TOLERANCE * lines.length) {
    throw new InvoicePlanError(`The instalments total ${total.toFixed(2)} but the line item is ${round2(itemNetValue).toFixed(2)} — a partial invoicing plan must add up to the full line value`);
  }
  if (remainder !== 0) {
    const last = lines[lines.length - 1];
    last.amount = round2(last.amount + remainder);
    last.percentage = round2((last.amount / itemNetValue) * 100);
  }

  return lines;
};

/**
 * Builds a complete plan from what a buyer configured, for one PO line item.
 * Existing lines are carried over by lineNumber so that regenerating a plan
 * never loses the invoices already raised against it — the one destructive
 * mistake this feature could make.
 */
const buildPlan = (input, { item, currency = 'INR', existingPlan = null } = {}) => {
  const type = input.type;
  if (!PLAN_TYPES.includes(type)) {
    throw new InvoicePlanError(`Invoicing plan type must be one of ${PLAN_TYPES.join(', ')}`);
  }
  if (input.invoicingRule && !INVOICING_RULES.includes(input.invoicingRule)) {
    throw new InvoicePlanError(`Invoicing rule must be one of ${INVOICING_RULES.join(', ')}`);
  }

  const itemNetValue = Number(item?.netValue ?? 0);
  let lines;
  let periodicAmount;

  if (type === 'Periodic') {
    // SAP's periodic default: the line item's own value is what recurs. An
    // explicit periodicAmount overrides it for the case where the PO line
    // carries the contract total instead.
    periodicAmount = Number(input.periodicAmount ?? itemNetValue);
    lines = generatePeriodicLines({
      startDate: input.startDate,
      endDate: input.endDate,
      frequency: input.frequency,
      periodicAmount,
      invoicingRule: input.invoicingRule || 'Arrears',
    });
  } else {
    lines = buildPartialLines({ milestones: input.milestones, itemNetValue });
  }

  // Carry forward anything already invoiced. A line that has been billed keeps
  // its status, its amount and its invoice reference regardless of what the new
  // configuration says about it — you cannot un-invoice by editing a schedule.
  const billedByNumber = new Map(
    (existingPlan?.lines || [])
      .filter((line) => line.invoiceId)
      .map((line) => [line.lineNumber, line]),
  );
  const reconciled = lines.map((line) => {
    const billed = billedByNumber.get(line.lineNumber);
    if (!billed) return line;
    billedByNumber.delete(line.lineNumber);
    return {
      ...line,
      amount: billed.amount,
      percentage: billed.percentage,
      settlementDate: billed.settlementDate,
      status: billed.status,
      invoiceId: billed.invoiceId,
      invoiceNumber: billed.invoiceNumber,
      invoicedAt: billed.invoicedAt,
      sapMiroDoc: billed.sapMiroDoc,
    };
  });

  // An invoiced line the new schedule has no slot for is kept rather than
  // dropped, so the plan still accounts for every rupee already billed.
  const orphaned = [...billedByNumber.values()].map((line) =>
    (typeof line.toObject === 'function' ? line.toObject() : { ...line }),
  );

  const allLines = [...reconciled, ...orphaned].sort(
    (a, b) => new Date(a.settlementDate) - new Date(b.settlementDate),
  );

  return {
    enabled: true,
    planNumber: existingPlan?.planNumber || input.planNumber || null,
    type,
    startDate: type === 'Periodic' ? atUtcMidnight(input.startDate) : allLines[0]?.settlementDate,
    endDate: type === 'Periodic' ? atUtcMidnight(input.endDate) : allLines[allLines.length - 1]?.settlementDate,
    frequency: type === 'Periodic' ? input.frequency : undefined,
    invoicingRule: type === 'Periodic' ? (input.invoicingRule || 'Arrears') : undefined,
    periodicAmount: type === 'Periodic' ? round2(periodicAmount) : undefined,
    currency: input.currency || currency,
    reference: input.reference || existingPlan?.reference,
    lines: allLines,
    source: input.source || 'portal',
    syncedAt: input.source === 'sap' ? new Date() : existingPlan?.syncedAt,
  };
};

/** True when this line may be invoiced right now. */
const isLineDue = (line, asOf = new Date()) =>
  line.status === LINE_OPEN && !line.blocked && new Date(line.settlementDate) <= asOf;

/**
 * What a screen needs to say about a plan in one glance: how much of it is
 * billed, what is due now, and what comes next.
 */
const summarizePlan = (plan, asOf = new Date()) => {
  if (!plan?.enabled) return null;
  const lines = plan.lines || [];

  const totalValue = round2(lines.reduce((sum, line) => sum + (line.amount || 0), 0));
  const invoicedLines = lines.filter((line) => line.status === 'Invoiced');
  const invoicedValue = round2(invoicedLines.reduce((sum, line) => sum + (line.amount || 0), 0));
  const dueLines = lines.filter((line) => isLineDue(line, asOf));
  const upcoming = lines
    .filter((line) => line.status === LINE_OPEN && !isLineDue(line, asOf))
    .sort((a, b) => new Date(a.settlementDate) - new Date(b.settlementDate));

  return {
    type: plan.type,
    frequency: plan.frequency,
    invoicingRule: plan.invoicingRule,
    currency: plan.currency,
    totalLines: lines.length,
    totalValue,
    invoicedLines: invoicedLines.length,
    invoicedValue,
    // Only the OPEN remainder — a blocked line is still owed, so it counts here
    // even though it cannot be invoiced yet.
    openValue: round2(totalValue - invoicedValue),
    dueLines: dueLines.length,
    dueValue: round2(dueLines.reduce((sum, line) => sum + (line.amount || 0), 0)),
    nextDueDate: (dueLines[0] || upcoming[0])?.settlementDate || null,
    blockedLines: lines.filter((line) => line.blocked && line.status === LINE_OPEN).length,
    complete: lines.length > 0 && invoicedLines.length === lines.length,
  };
};

/** Every plan line across a PO that could be invoiced today, flattened with the
 *  item it belongs to — what the supplier's "what can I bill?" list is built from. */
const billablePlanLines = (po, asOf = new Date()) =>
  (po.items || []).flatMap((item) => {
    if (!item.invoicePlan?.enabled) return [];
    return (item.invoicePlan.lines || [])
      .filter((line) => isLineDue(line, asOf))
      .map((line) => ({
        poId: po.id,
        line: item.line,
        materialCode: item.materialCode,
        description: item.description,
        planType: item.invoicePlan.type,
        currency: item.invoicePlan.currency || po.currency || 'INR',
        planLineNumber: line.lineNumber,
        planLineDescription: line.description,
        settlementDate: line.settlementDate,
        amount: line.amount,
        percentage: line.percentage,
      }));
  });

/** Does this purchase order have invoice planning switched on anywhere? */
const hasInvoicePlan = (po) => (po?.items || []).some((item) => item.invoicePlan?.enabled);

module.exports = {
  PLAN_TYPES,
  INVOICING_RULES,
  FREQUENCIES: Object.keys(FREQUENCY_STEPS),
  MAX_PLAN_LINES,
  InvoicePlanError,
  addMonths,
  generatePeriodicLines,
  buildPartialLines,
  buildPlan,
  isLineDue,
  summarizePlan,
  billablePlanLines,
  hasInvoicePlan,
  round2,
};
