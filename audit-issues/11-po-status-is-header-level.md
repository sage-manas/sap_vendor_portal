<!-- title: DESIGN: purchase order state is header-level, so a partially delivered or partially invoiced order cannot be represented -->
<!-- labels: bug,severity:high,area:sap,area:data,backend -->

**Severity:** High — the core P2P document cannot represent the states real orders spend
most of their life in.

## Summary

`PoStatus` is a single header enum, `Open → Acknowledged → Dispatched → Delivered → Invoiced
→ Paid`. Real purchase orders do not have that. State lives per line item, and SAP tracks
delivery completed (`ELIKZ`), final invoice (`EREKZ`), deletion (`LOEKZ`) and release status
per item, with the header status derived from order history (`EKBE`).

Consequences already visible in the code:

- A three-line order where one line ships cannot be described.
- `submitInvoice` sets the whole order to `Invoiced` on the first invoice, so a twelve-month
  periodic invoicing plan flips the order to "Invoiced" after month one and stays there for
  the remaining eleven.
- The same line is an unconditional write, so an order already at `Paid` regresses to
  `Invoiced`.

## Evidence

`backend/prisma/schema.prisma:62-69`:
```prisma
enum PoStatus { Open Acknowledged Dispatched Delivered Invoiced Paid }
```

`backend/controllers/invoice.controller.js:185` — unconditional, header-level:
```js
await prisma.purchaseOrder.update({ where: { pk: po.pk }, data: { status: 'Invoiced' } });
```

`PurchaseOrderItem` does carry `grnQuantity` (`schema.prisma:513`), so the data to derive
line state partly exists — it is simply not modelled or used.

## Steps to reproduce

1. Create a PO with lines 10, 20 and 30.
2. Acknowledge, ship and receive line 10 only.
3. Submit an invoice for line 10.
4. `GET /api/pos/:id` reports `status: "Invoiced"` for the whole order. Lines 20 and 30 are
   untouched but the order presents as fully invoiced to both the supplier and the buyer.

For the plan case: configure a monthly periodic plan, submit month one, observe the order
sits at `Invoiced` for the next eleven months.

## Expected

- Per-line state: ordered / delivered / invoiced quantities, delivery-complete and
  final-invoice flags, a blocked flag and a deletion indicator.
- Header status derived from line state, not written directly.
- Status transitions are monotonic unless an explicit reversal occurs.

## Suggested fix

Add to `PurchaseOrderItem`: `invoicedQuantity`, `deliveryCompleted`, `finalInvoice`,
`blocked`, `deleted`. Replace the direct header writes with a `derivePoStatus(po)` helper
that computes from items. Keep the header enum for display compatibility.

This is a schema change with data migration — worth sequencing alongside #12, #13 and #14,
which touch the same tables.

## Acceptance criteria

- [ ] A partially delivered, partially invoiced PO renders correctly for both planes.
- [ ] A periodic plan does not flip the order to `Invoiced` until the plan is complete.
- [ ] No code path writes `PurchaseOrder.status` directly.
- [ ] Status cannot regress.
