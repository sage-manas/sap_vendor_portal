/** Seed / initial demo data for the Dashboard feature domain. */
export const INITIAL_CHATS = [
  {
    id: 'MSG-001',
    sender: 'System',
    message: 'Welcome to the Supplier Portal. Please go to the Onboarding tab to complete your registration.',
    timestamp: '2026-06-02T10:00:00Z'
  }
];

// Unknown until GET /vendors/performance answers. Every score starts null so a
// screen shows "—" rather than a grade nobody earned.
export const INITIAL_PERFORMANCE = {
  deliveryOTIF: null,
  qualityAcceptance: null,
  invoiceAccuracy: null,
  weightedScore: null,
  grade: null
};
