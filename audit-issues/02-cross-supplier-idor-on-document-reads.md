<!-- title: SECURITY: any supplier can read any other supplier's PO, invoice, payment, GRN and ASN by id -->
<!-- labels: security,severity:critical,area:rfq,backend -->

**Severity:** Critical — cross-supplier data leak inside every tenant.

## Summary

Every document-by-id handler resolves on `{ id: req.params.id }` alone. The Prisma tenant
extension scopes the query to the caller's tenant, and that is the only boundary applied —
there is no check that the document belongs to the calling supplier. The `VENDOR` role holds
`PO_READ`, `INVOICE_READ`, `PAYMENT_READ`, `GRN_READ` and `ASN_READ`
(`backend/config/permissions.js`), so a supplier reaches all of these.

The list endpoints are correct — they use `withVendorScope(req)`. Only the by-id paths are
missing the filter, which is why this has gone unnoticed.

## Evidence

| Endpoint | File:line | Query |
|---|---|---|
| `GET /api/pos/:id` | `controllers/po.controller.js:149` | `findFirst({ where: { id: req.params.id } })` |
| `GET /api/pos/:id/asn` | `controllers/po.controller.js:284` | `findMany({ where: { poId: req.params.id } })` |
| `GET /api/invoices/:id` | `controllers/invoice.controller.js:70` | `findFirst({ where: { id: req.params.id } })` |
| `GET /api/payments/:id` | `controllers/payment.controller.js:150` | `findFirst({ where: { id: req.params.id } })` |
| `GET /api/grns/:id` | `controllers/grn.controller.js:48` | `findFirst({ where: { id: req.params.id } })` |

Contrast `getInvoices` (`controllers/invoice.controller.js:44`), which does it correctly:
```js
const where = withVendorScope(req);
```

## Steps to reproduce

1. Two approved suppliers A and B in the same tenant; B has purchase order `PO-2026-0081`.
2. As A:
   ```
   curl -H "Authorization: Bearer $SUPPLIER_A_TOKEN" \
        http://localhost:5000/api/pos/PO-2026-0081
   ```
3. A receives B's purchase order: buyer name, delivery address, every line item, unit prices
   and net values.

PO ids are sequential (`PO-2026-0081`); invoice and payment ids are `INV-`/`PMT-` plus six
digits, a 900k space with no per-account rate limit outside production
(`middleware/rateLimiter.js` mounts `apiLimiter` only when `NODE_ENV === 'production'`).

## Expected

A supplier resolving a document that is not theirs gets 404 — the same response as a
document that does not exist, so the id space is not confirmable.

## Suggested fix

One resolver, used everywhere, rather than five independent fixes:

```js
// utils/requestScope.js
const scopedWhere = (req, where = {}) =>
  req.scopeVendorId ? { ...where, vendorId: req.scopeVendorId } : where;
```

then e.g. `prisma.purchaseOrder.findFirst({ where: scopedWhere(req, { id: req.params.id }) })`.
For `getASNForPO`, scope on the parent PO, not on the ASN rows.

## Acceptance criteria

- [ ] All five endpoints above return 404 for another supplier's document.
- [ ] A route × role × ownership test matrix, in the style of the existing
      `tests/route-role-matrix.test.js`, asserting every `:id` route rejects a
      non-owning supplier.
- [ ] A lint rule or review checklist entry: no `findFirst({ where: { id: req.params.id } })`
      in a supplier-reachable handler.
