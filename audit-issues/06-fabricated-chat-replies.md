<!-- title: INTEGRITY: the backend writes fabricated Buyer, Finance, Quality and Warehouse chat replies, one claiming SAP was updated -->
<!-- labels: bug,severity:critical,integrity,backend -->

**Severity:** Critical — the system tells suppliers things that are not true, and persists
them as if a human said them.

## Summary

`sendMessage` schedules a `setTimeout` that writes a keyword-matched reply into the tenant's
`chat_messages` table, attributed to `Buyer`, `Finance`, `Quality` or `Warehouse`. No human
sent these. They are persisted rows, visible to the buying organisation's own staff, and they
make substantive claims.

The default reply asserts a SAP write that never happened:

> "We have received your query and updated the transaction record in SAP."

Another gives tax advice under the Finance role:

> "Tax code G1 (18% GST) applies to regular domestic supplies…"

In a payment or quality dispute, this chat log is the record both parties refer to.

## Evidence

`backend/controllers/chat.controller.js:58` — the false claim:
```js
let replyText = "We have received your query and updated the transaction record in SAP. ...";
```

`backend/controllers/chat.controller.js:61-70` — keyword matcher choosing a sender role.

`backend/controllers/chat.controller.js:74-93` — persisted and broadcast:
```js
setTimeout(() => runWithTenant(clientId, async () => {
  const replyMsg = await prisma.chatMessage.create({ data: { vendorId, sender: senderRole, ... } });
```

There is a matching client-side simulation in
`src/features/purchase-order/components/PurchaseOrdersView.jsx:312-449` (`poChats`, seeded
with a scripted greeting and answered by a `setTimeout` keyword matcher) — the two should be
removed together.

Secondary defect: this `setTimeout` does database work outside any request or job, which is
exactly the pattern the Phase 1 job runtime exists to eliminate. It is lost on restart and
has no retry.

## Steps to reproduce

1. As a supplier: `POST /api/chats` with `{"message":"what is the price on this order?"}`.
2. Wait two seconds, then `GET /api/chats`.
3. A message from sender `Finance` is present that no finance user sent.
4. Query the buyer-side view: the same fabricated message appears in the tenant's record.

## Expected

The portal does not author messages attributed to human roles. Either a real person replies,
or nothing is written.

## Suggested fix

Delete the auto-reply block (`chat.controller.js:56-93`) and the client-side equivalent. If
an acknowledgement is wanted, send it from sender `System` with unambiguous wording
("Your message has been sent to the buyer's procurement team") and make no claim about SAP.

Data cleanup: existing fabricated rows should be identified and either deleted or relabelled
`System`, since they are currently indistinguishable from genuine buyer messages.

## Acceptance criteria

- [ ] No code path writes a `ChatMessage` with sender `Buyer`, `Finance`, `Quality` or
      `Warehouse` unless a user with that role authored it.
- [ ] No message text claims a SAP write.
- [ ] Migration or script to relabel historical auto-replies.
- [ ] Test asserts that posting a supplier message creates exactly one row.
