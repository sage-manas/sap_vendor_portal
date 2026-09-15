<!-- title: BUG: the discovery sweep never re-reads a purchase order it has already correlated, so SAP-side changes are lost forever -->
<!-- labels: bug,severity:medium,area:sap,backend -->

**Severity:** Medium — the portal presents stale data as current.

## Summary

`upsertOrder` returns early for any purchase order already in `synced` state. The sweep is
therefore discovery-only: once an order is correlated, nothing ever reads it again.

Changes made in SAP after correlation are invisible to the portal indefinitely:

- Quantity or price changed on a line
- A line added or deleted
- The order flagged for deletion
- Further goods receipts posted
- The order blocked or its release revoked

The supplier keeps seeing the version captured at first sight, and acts on it.

## Evidence

`backend/jobs/handlers/sweepPurchaseOrders.js:75`:
```js
if (existing.sapSyncState === 'synced') return;
```

The fingerprint machinery would already detect the change — `recordSweepTick` at `:48`
compares the whole response — so the sweep knows something changed and then declines to act
on it for exactly the orders most likely to matter.

## Steps to reproduce

1. Let the sweep discover and correlate a purchase order.
2. In SAP, change a line quantity on that order.
3. Run the sweep again. The fingerprint changes, `upsertOrder` runs, and returns at line 75.
4. `GET /api/pos/:id` still shows the original quantity.

## Expected

A synced purchase order is refreshed from SAP when SAP's copy changes. SAP is the system of
record for orders — the portal mirrors it, so the mirror must track.

## Suggested fix

Replace the early return with a field-level reconcile: compare line quantities, prices,
received quantities and header fields, update what differs, and emit a socket event when a
supplier-visible field changes. Keep `sapSyncState` as `synced` throughout; it describes
correlation, not freshness — add `sapSyncedAt` refresh so staleness is visible.

Handle deletion explicitly: an order that disappears from SAP's response, or arrives with a
deletion indicator, should be marked rather than silently retained.

This depends on #11 (line-level state) to be fully correct, but the header and quantity
refresh can land first.

## Acceptance criteria

- [ ] A quantity change in SAP appears in the portal after the next sweep.
- [ ] A deleted SAP order is marked, not silently kept.
- [ ] The supplier is notified when a line they have not yet shipped changes.
- [ ] Test: sweep twice with a changed payload, assert the update.
