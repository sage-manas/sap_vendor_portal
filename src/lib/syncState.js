// Dual identity / sync state (backend/config/statuses.js SAP_SYNC_STATE) —
// Phase 3 of docs/04-sap-runtime-engineering-plan.md, invariant I5: a number
// shown to a supplier is either from SAP or clearly marked as not. This is
// the one place a supplier-facing screen turns a raw `sapSyncState` into
// words, so "pending" doesn't quietly become five different sentences across
// five components.
//
// SAP_SYNC_STATES names the values the backend registry declares —
// syncState.test.js checks this list against the real module via
// createRequire, so a renamed/added state fails CI instead of a screen
// silently falling through to the `local`/unknown default below.
export const SAP_SYNC_STATES = ['local', 'pending', 'synced', 'failed', 'orphaned'];

/**
 * `{ label, tone, showNumber }` for one sapSyncState value.
 * `tone` matches the console's Status badge vocabulary
 * (src/components/console/primitives.jsx) — 'active' | 'pending' | 'warn' | 'suspended'.
 * `showNumber` is the invariant itself: only `synced` may display the real
 * SAP document number; every other state must show this label instead.
 */
export function describeSyncState(sapSyncState) {
  switch (sapSyncState) {
    case 'synced':
      return { label: 'Confirmed', tone: 'active', showNumber: true };
    case 'pending':
      return { label: 'Awaiting SAP confirmation', tone: 'pending', showNumber: false };
    case 'failed':
    case 'orphaned':
      return { label: 'Not yet recorded in SAP — your buyer has been notified', tone: 'suspended', showNumber: false };
    case 'local':
    default:
      // Portal-internal by design (an RFQ, mainly) — not a deficiency, so no
      // warning tone. See the note on RFQ.sapSyncState in schema.prisma.
      return { label: 'Managed in this portal', tone: 'pending', showNumber: false };
  }
}
