<!-- title: DESIGN: Payment is modelled one-to-one with Invoice, so an F110 run paying several invoices cannot be represented -->
<!-- labels: bug,severity:high,area:sap,area:data,backend -->

**Severity:** High — the payment model does not match how SAP actually pays.

## Summary

A payment run (F110) settles many open items in one payment document, with one clearing
document and one UTR reference. `Payment` carries a single `invoiceId`, so:

- A consolidated payment covering five invoices cannot be recorded as one payment. Either it
  is split into five fabricated payments, or four invoices never show as paid.
- A partial payment or residual item has no representation.
- The reverse case — one invoice settled across two runs — is equally unrepresentable.

The supplier-facing consequence is that the payment advice a supplier sees will not reconcile
against the remittance their bank shows, which is the single most common support ticket a
vendor portal generates.

## Evidence

`backend/prisma/schema.prisma:787-790`:
```prisma
invoiceId String
invoice   Invoice       @relation(fields: [clientId, invoiceId], references: [clientId, id])
```

`backend/sap/drivers/s4odata.driver.js:1229` — the id is minted from the MIRO document, so
the model assumes one payment per invoice from the start:
```js
paymentId: `PMT-${found.miroDoc}`,
```

Related: `Invoice.grnId` is likewise a single reference (`schema.prisma:715`), so an invoice
covering several goods receipts cannot be modelled either.

## Expected

- `Payment` is a header (clearing document, UTR, payment date, method, run id, company code,
  fiscal year) with a child table of settled items, each referencing an invoice and an
  amount.
- Partial settlement is representable: an invoice can be partly cleared.
- `Invoice` can reference multiple goods receipts.

## Suggested fix

Introduce `PaymentItem { paymentPk, invoiceId, grossAmount, tdsDeducted, netAmount }` and
move the per-invoice amounts off the `Payment` header. Keep a denormalised
`Payment.invoiceId` during migration if the UI depends on it, but stop writing it.

`awaitPaymentRun` then persists one payment with N items rather than one payment per invoice.

## Acceptance criteria

- [ ] One clearing document covering three invoices produces one `Payment` with three items.
- [ ] A partially settled invoice reports its outstanding balance.
- [ ] Payment tracking in the UI sums per remittance, matching what the bank shows.
