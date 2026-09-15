<!-- title: INTEGRITY: PUT /api/payments/:id/status reports success while writing nothing -->
<!-- labels: bug,severity:high,integrity,backend -->

**Severity:** High — an API that confirms an action it did not perform.

## Summary

`status` is not a column on `Payment` and never was. The handler loads the payment, writes
nothing, splices `status` onto the response object in memory, and returns
`"Payment status updated successfully"`. The code comment documents this and states it was
deliberately preserved through the Prisma migration.

An honest comment on a dishonest response is still a dishonest response. Any caller — the
UI, an integration, a future automation — that relies on this endpoint is silently broken,
and a user who clicks the button sees a success toast.

## Evidence

`backend/controllers/payment.controller.js:181-186` (comment) and `:196-200`:
```js
res.json({ message: 'Payment status updated successfully', payment: { ...formatPayment(payment), status } });
```

`backend/prisma/schema.prisma:782-829` — the `Payment` model has no `status` field.

## Steps to reproduce

```
curl -X PUT -H "Authorization: Bearer $FINANCE_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"Cleared"}' http://localhost:5000/api/payments/PMT-123456/status
```
Response: 200 with `"Payment status updated successfully"`. Then
`GET /api/payments/PMT-123456` — nothing changed.

## Expected

Either the endpoint does something, or it does not exist.

## Suggested fix

A payment's state in this system is derived from SAP clearing, not set by a user — so the
right answer is almost certainly removal. Delete the route and handler, and remove any UI
affordance that calls it. If a genuine need exists (an internal annotation, say), model it as
a real column with a validated value set and a state machine.

## Acceptance criteria

- [ ] The route is removed, or backed by a real column.
- [ ] No UI control calls it.
- [ ] Grep confirms no other handler returns a success message without a corresponding write.
