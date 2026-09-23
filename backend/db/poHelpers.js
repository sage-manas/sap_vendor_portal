const { prisma } = require('./prisma');
const { toNumber } = require('../utils/money');
const { toNumber: toQty } = require('../utils/quantity');
const { statusRank, derivePoStatus } = require('../services/poStatus.service');

// Shared between po.controller.js and invoice.controller.js: both need a
// PurchaseOrder reshaped with its items' invoicePlan back into the plain-
// object shape services/invoicePlan.service.js expects (see po.controller.js
// for the fuller explanation of why this reconstruction exists).

// Both orderings are load-bearing, not cosmetic. Postgres returns rows in heap
// order when no ORDER BY is given, and an UPDATE rewrites a row at the end of
// the heap — so invoicing a plan line silently moved it to the back, and
// `items[0]` / `lines[0]` stopped meaning "line 1". That reordered the schedule
// under the supplier mid-flow and made anything indexing into these arrays
// nondeterministic.
const PO_INCLUDE = {
  items: {
    orderBy: { line: 'asc' },
    include: {
      invoicePlan: { include: { lines: { orderBy: { lineNumber: 'asc' } } } },
    },
  },
};

// amount/periodicAmount/unitPrice/netValue are Decimal-typed columns —
// converted to plain numbers here, the one place every consumer (API
// responses, services/invoicePlan.service.js's schedule math, the 3-way match
// in controllers/invoice.controller.js) reads a PO/plan back through. See
// utils/money.js for why this can't be left to `*`/`-`'s implicit coercion.
const formatPlanLine = (line) => ({
  lineNumber: line.lineNumber,
  description: line.description,
  settlementDate: line.settlementDate,
  billingDate: line.billingDate,
  percentage: line.percentage,
  amount: toNumber(line.amount),
  status: line.status,
  blocked: line.blocked,
  invoiceId: line.invoiceId,
  invoiceNumber: line.invoiceNumber,
  invoicedAt: line.invoicedAt,
  sapMiroDoc: line.sapMiroDoc,
});

const formatPlan = (plan) => (!plan ? { enabled: false } : {
  enabled: plan.enabled,
  planNumber: plan.planNumber,
  type: plan.type,
  startDate: plan.startDate,
  endDate: plan.endDate,
  frequency: plan.frequency,
  invoicingRule: plan.invoicingRule,
  periodicAmount: toNumber(plan.periodicAmount),
  currency: plan.currency,
  reference: plan.reference,
  lines: (plan.lines || []).map(formatPlanLine),
  source: plan.source,
  syncedAt: plan.syncedAt,
  // A supplier's proposed change awaiting approval, or null. Raw — it is
  // {input, requestedAt, requestedBy} (see the InvoicePlan.pendingChange
  // comment in schema.prisma), not itself a plan, so it is passed through
  // rather than run through the numeric conversions above.
  pendingChange: plan.pendingChange || null,
});

const formatPoItem = (item) => {
  const { pk, clientId, poPk, invoicePlan, unitPrice, netValue, quantity, grnQuantity, ...rest } = item;
  return {
    ...rest,
    unitPrice: toNumber(unitPrice),
    netValue: toNumber(netValue),
    quantity: toQty(quantity),
    grnQuantity: toQty(grnQuantity),
    invoicePlan: formatPlan(invoicePlan),
  };
};

const formatPo = (po) => {
  const { items, ...rest } = po;
  return { ...rest, items: (items || []).map(formatPoItem) };
};

// Prisma's DateTime columns need a real Date (or a full ISO-8601 datetime
// string) — a date-only string like "2020-01-01" fails with "premature end of
// input". buildPlan()'s own output already carries real Date instances, but
// syncInvoicePlan (controllers/po.controller.js) feeds this function a plan
// built from the SAP driver's response, whose dates are deliberately
// date-only (sap/drivers/mock.driver.js's isoDay(), matching the real
// driver's SAP-native date convention). `new Date(x)` is a safe passthrough
// for an already-Date `x`, so this is applied unconditionally rather than
// trying to tell the two shapes apart.
const toDateOrNull = (value) => (value ? new Date(value) : null);

// Persists a rebuilt plan (the plain object buildPlan() returns) onto a PO
// line item: upserts the InvoicePlan row 1:1 with the item, then replaces its
// InvoicePlanLine children wholesale — buildPlan already carries forward
// anything previously invoiced, so a full replace here never loses billing
// history, it just re-states it.
const persistInvoicePlan = async (item, plan) => {
  const planData = {
    enabled: plan.enabled,
    planNumber: plan.planNumber || null,
    type: plan.type || null,
    startDate: toDateOrNull(plan.startDate),
    endDate: toDateOrNull(plan.endDate),
    frequency: plan.frequency || null,
    invoicingRule: plan.invoicingRule || 'Arrears',
    periodicAmount: plan.periodicAmount ?? null,
    currency: plan.currency || 'INR',
    reference: plan.reference || null,
    source: plan.source || 'portal',
    syncedAt: plan.syncedAt || null,
    // Any successful write to this plan — the buying organisation's own edit,
    // an adopted SAP sync, or an approved supplier proposal — supersedes
    // whatever was pending. A caller that just applied a proposal has already
    // cleared it explicitly on the row it read; this is what catches every
    // other path (configureInvoicePlan, syncInvoicePlan) so a stale proposal
    // can never survive a plan it no longer describes.
    pendingChange: null,
  };

  const planRow = item.invoicePlan
    ? await prisma.invoicePlan.update({ where: { pk: item.invoicePlan.pk }, data: planData })
    : await prisma.invoicePlan.create({ data: { itemPk: item.pk, ...planData } });

  await prisma.invoicePlanLine.deleteMany({ where: { planPk: planRow.pk } });
  if (plan.lines?.length) {
    await prisma.invoicePlanLine.createMany({
      data: plan.lines.map((line) => ({
        planPk: planRow.pk,
        lineNumber: line.lineNumber,
        description: line.description,
        settlementDate: toDateOrNull(line.settlementDate),
        billingDate: toDateOrNull(line.billingDate),
        percentage: line.percentage,
        amount: line.amount,
        status: line.status,
        blocked: line.blocked,
        invoiceId: line.invoiceId,
        invoiceNumber: line.invoiceNumber,
        invoicedAt: line.invoicedAt,
        sapMiroDoc: line.sapMiroDoc,
      })),
    });
  }

  return prisma.invoicePlan.findFirst({ where: { pk: planRow.pk }, include: { lines: true } });
};

// Switches a line's plan off. Rather than delete the InvoicePlan row (which
// would lose the billing history on its lines), enabled is set false — same
// as the old `{ enabled: false }` replacement, which likewise discarded the
// in-memory schedule but kept nothing else around to delete.
const disableInvoicePlan = (item) =>
  prisma.invoicePlan.update({ where: { pk: item.invoicePlan.pk }, data: { enabled: false } });

// The one place PurchaseOrder.status is ever written (issue #60). Every event
// that used to set it directly — acknowledge, ASN submission, a goods
// receipt, an invoice clearing — instead updates the fact that actually
// changed (acknowledgedAt, an ASN row, an item's grnQuantity, an invoice's
// status) and calls this afterward, inside the same transaction when one is
// already open. `client` is `prisma` or a `tx` — whichever the caller is
// already using, so this participates in the caller's transaction rather
// than opening a second one.
//
// Re-fetches the PO rather than trusting what the caller has in memory: the
// point of calling this from inside a transaction is to see the write that
// transaction just made (a plain in-memory po object wouldn't).
//
// Never regresses: only writes when the derived status outranks the stored
// one, so a stale/duplicate job re-running this against an already-`Paid`
// order can never move it backward.
const syncPoStatus = async (client, poPk) => {
  const po = await client.purchaseOrder.findFirst({ where: { pk: poPk }, include: PO_INCLUDE });
  if (!po) return null;

  const [asnCount, invoices] = await Promise.all([
    client.aSN.count({ where: { poId: po.id } }),
    client.invoice.findMany({ where: { poId: po.id }, include: { items: true } }),
  ]);

  const invoicedQtyByLine = new Map();
  for (const invoice of invoices) {
    for (const item of invoice.items) {
      if (item.line == null) continue;
      // item.quantity is Decimal-typed (issue #65) — `+` on two Decimal
      // instances (or a number and a Decimal) is string concatenation, not
      // addition; see utils/money.js's header comment.
      invoicedQtyByLine.set(item.line, (invoicedQtyByLine.get(item.line) || 0) + toQty(item.quantity));
    }
  }

  const derived = derivePoStatus(po, {
    asnCount,
    invoicedQtyByLine,
    invoiceCount: invoices.length,
    allInvoicesCleared: invoices.length > 0 && invoices.every((invoice) => invoice.status === 'Cleared'),
  });

  if (statusRank(derived) <= statusRank(po.status)) return po;

  return client.purchaseOrder.update({ where: { pk: po.pk }, data: { status: derived }, include: PO_INCLUDE });
};

module.exports = {
  PO_INCLUDE,
  formatPlanLine,
  formatPlan,
  formatPoItem,
  formatPo,
  persistInvoicePlan,
  disableInvoicePlan,
  syncPoStatus,
};
