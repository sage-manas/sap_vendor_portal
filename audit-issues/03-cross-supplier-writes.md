<!-- title: SECURITY: a supplier can acknowledge, ship against, and invoice another supplier's purchase order -->
<!-- labels: security,severity:critical,area:rfq,backend -->

**Severity:** Critical — this is a financial fraud path, not only a data leak.

## Summary

The same missing ownership check as #02, but on write paths. Three handlers fetch the parent
document by id alone and then act on it using the *caller's* vendor scope, so the caller's
identity is stamped onto another supplier's document.

The worst case: supplier A submits an invoice against supplier B's goods receipt. The invoice
is created with A's `vendorId`, and the payment watch is enqueued against it. A is set up to
be paid for goods B delivered.

## Evidence

`backend/controllers/po.controller.js:160` — `acknowledgePO`, no ownership check, and it
fires a SAP write if `config.fields.poAcknowledgeField` is configured:
```js
const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id } });
```

`backend/controllers/po.controller.js:195` — `submitASN` takes the caller's vendor from the
token but the PO by id alone:
```js
const vendorId = requireVendorScope(req);
...
const po = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id }, include: PO_INCLUDE });
```

`backend/controllers/invoice.controller.js:88` — `submitInvoice`, GRN by id alone:
```js
const grn = await prisma.gRN.findFirst({ where: { id: grnId }, include: { items: true } });
```
…and then at line 155 the invoice is created with `vendorId` from the caller's scope, never
compared against `grn.vendorId` or `po.vendorId`.

## Steps to reproduce

1. Supplier B has `PO-2026-0081` in `Acknowledged` state and goods receipt `GRN-5000001234`
   with `invoiceSubmitted = false`.
2. As supplier A:
   ```
   curl -X POST -H "Authorization: Bearer $SUPPLIER_A_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"grnId":"GRN-5000001234","invoiceNumber":"A-FRAUD-001",
             "invoiceDate":"2026-09-14","subTotal":100000,"taxAmount":18000,
             "totalAmount":118000,
             "items":[{"line":10,"materialCode":"MAT-1","quantity":10,
                       "unitPrice":10000,"amount":100000}]}' \
        http://localhost:5000/api/invoices
   ```
3. The invoice is created with `vendorId = A`, `poId = B's PO`. `GRN.invoiceSubmitted` flips
   to true, so B can no longer invoice their own delivery. `PurchaseOrder.status` becomes
   `Invoiced`. An `awaitPaymentRun` job is enqueued.

Step 3 also denies service to B, independently of the payment outcome.

## Expected

- `acknowledgePO`, `submitASN` and `submitInvoice` operate only on documents belonging to
  the calling supplier; anything else is 404.
- `submitInvoice` additionally asserts `grn.vendorId === po.vendorId === callerVendorId`.

## Suggested fix

Use the `scopedWhere` helper from #02 on the parent lookups, and add an explicit consistency
assertion in `submitInvoice` before the create:

```js
if (grn.vendorId !== vendorId || po.vendorId !== vendorId) {
  return next(ApiError.notFound('The delivery receipt this invoice refers to was not found'));
}
```

## Acceptance criteria

- [ ] Supplier A cannot acknowledge, ASN against, or invoice supplier B's documents.
- [ ] Tests cover all three, asserting 404 and that no row was written.
- [ ] `GRN.invoiceSubmitted` is not mutated by a rejected request.
