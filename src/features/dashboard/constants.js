/** Seed / initial demo data for the Dashboard feature domain. */

// INITIAL_CHATS was removed with the rest of the chat wiring (issue #109):
// there is no thread view on any plane to seed.

// Unknown until GET /vendors/performance answers. Every score starts null so a
// screen shows "—" rather than a grade nobody earned.
export const INITIAL_PERFORMANCE = {
  deliveryOTIF: null,
  qualityAcceptance: null,
  invoiceAccuracy: null,
  weightedScore: null,
  grade: null
};
