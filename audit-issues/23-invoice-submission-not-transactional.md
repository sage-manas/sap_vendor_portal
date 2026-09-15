<!-- title: BUG: invoice submission performs four independent writes with no transaction -->
<!-- labels: bug,severity:medium,area:data,backend -->

**Severity:** Medium — a crash mid-sequence leaves the P2P chain inconsistent.

## Summary

`submitInvoice` creates the invoice, flips `GRN.invoiceSubmitted`, sets the purchase order
status and enqueues the payment-run job as four separate statements. A failure between any
two leaves a state that nothing reconciles:

- Invoice created, GRN not marked → the supplier can invoice the same receipt twice.
- GRN marked, PO not updated → the order shows as delivered while an invoice exists.
- Everything written, enqueue fails → the invoice never gets a payment watch and sits at
  `Submitted` forever with no job tracking it.

The codebase does this correctly elsewhere: `awardBid` (`controllers/rfq.controller.js:535`)
wraps its state change in `prisma.$transaction` with a conditional `updateMany` and treats
`count === 0` as a lost race. That is the pattern to reuse.

## Evidence

`backend/controllers/invoice.controller.js:153` — create
`backend/controllers/invoice.controller.js:182` — GRN update
`backend/controllers/invoice.controller.js:185` — PO update
`backend/controllers/invoice.controller.js:191` — enqueue

`submitPlanInvoice` has the same shape at `:245`, `:285` and `:290`.

## Steps to reproduce

Instrument `prisma.gRN.update` to throw once, submit an invoice, then submit again with the
same `grnId` — the second submission succeeds, producing two invoices for one goods receipt.

## Expected

The document writes commit atomically. The job enqueue either participates or is made
idempotent and retried.

## Suggested fix

Wrap the three writes in `prisma.$transaction`, with the GRN update expressed as a
conditional `updateMany({ where: { pk, invoiceSubmitted: false } })` so a concurrent second
submission loses the race and rolls back rather than duplicating.

The enqueue is already idempotent via `dedupeKey` (`jobs/queue.js`), so it can follow the
transaction — but a failure there should be logged loudly and swept, not swallowed.

## Acceptance criteria

- [ ] Invoice, GRN and PO writes are atomic.
- [ ] Two concurrent submissions against one GRN produce exactly one invoice.
- [ ] An invoice with no corresponding job is detected by a sweep and repaired.
