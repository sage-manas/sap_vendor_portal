// Empty-but-correctly-shaped responses for every endpoint a page loads.
//
// "Empty" is the interesting case for a smoke test: it is where a page either
// shows an honest empty state or throws on `data.something.missing`. The
// shapes here are taken from the backend controllers that serve them, so a
// page that reads a field the API does not return fails here rather than in
// front of a user.
//
// A test that needs rows spreads over the relevant key:
//   api: { ...EMPTY_SUPPLIER_API, 'GET /rfqs': { rfqs: [oneRfq] } }

export const emptyList = (key) => ({ [key]: [], pagination: { total: 0, page: 1, limit: 20, pages: 0 } });

// ---------------------------------------------------------------------------
// Supplier portal
// ---------------------------------------------------------------------------

export const VENDOR_PROFILE = {
  pk: 'vendor-pk-1',
  vendorId: 'VND-00001',
  companyName: 'Test Supplier Pvt Ltd',
  email: 'supplier@example.com',
  phone: '9876543210',
  status: 'Approved',
  sapVendorCode: 'VND-51204',
  gstin: '27AABCB1234F1Z5',
  pan: 'AABCB1234F',
  address: '12 MG Road',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  bankName: 'HDFC Bank',
  accountNumber: '123456789012',
  ifscCode: 'HDFC0000060',
  accountName: 'Test Supplier Pvt Ltd',
  bankBranch: 'Pune Main',
  msmeRegistered: false,
  documents: [],
  submittedAt: '2026-01-01T00:00:00.000Z',
};

export const DASHBOARD_SUMMARY = {
  counts: { rfqs: 0, pos: 0, invoices: 0, payments: 0, asns: 0, grns: 0 },
  recentActivity: [],
  outstanding: { invoices: 0, value: 0 },
};

export const EMPTY_SUPPLIER_API = {
  'GET /vendors/profile': VENDOR_PROFILE,
  'GET /dashboard/summary': DASHBOARD_SUMMARY,
  'GET /rfqs': emptyList('rfqs'),
  'GET /pos': emptyList('pos'),
  'GET /invoices': emptyList('invoices'),
  'GET /payments': emptyList('payments'),
  // GET /asns answers a bare array, not { asns, pagination } like the others.
  'GET /asns': [],
  'GET /grns': emptyList('grns'),
  'GET /chats': { messages: [] },
  'GET /logs': [],
  'GET /vendors/performance': {
    onTimeDeliveryRate: 0, qualityScore: 0, totalOrders: 0, totalValue: 0, history: [],
  },
  'GET /reports/metrics': { metrics: {} },
  'GET /rfqs/sap-status': { documents: [] },
  'GET /pos/sap-status': { orders: [] },
  'GET /invoices/sap-status': { documents: [] },
  'GET /payments/sap-status': { documents: [] },
  'GET /rfqs/sap-quotations': { documents: [] },
  'GET /vendors/sap-reference-data': { paymentTerms: [], incoterms: [], currencies: [], plants: [] },
  'GET /uploads': { documents: [] },
};

// ---------------------------------------------------------------------------
// Tenant workspace
// ---------------------------------------------------------------------------

// Every workspace response carries this identity block — the overview and the
// settings screen both title themselves from it. See workspaceIdentity() in
// backend/controllers/workspace.controller.js.
export const WORKSPACE_IDENTITY = {
  clientId: 'CLT-0001',
  companyName: 'Nucleus Manufacturing',
  slug: 'legacy',
  plan: 'standard',
  status: 'Active',
  sapEnvironment: 'sandbox',
  branding: { logo: null, primaryColor: null },
};

// Shape from backend/controllers/workspace.controller.js's overview handler.
export const WORKSPACE_OVERVIEW = {
  workspace: WORKSPACE_IDENTITY,
  suppliers: { total: 0, approved: 0, awaitingDecision: 0, overdueDecision: 0, limit: null },
  sourcing: { rfqsTotal: 0, openRfqs: 0, awardedRfqs: 0, posTotal: 0, openPos: 0 },
  finance: {
    invoicesTotal: 0,
    invoicesOpen: 0,
    invoicesOverThreshold: 0,
    invoicesOpenValue: 0,
    reviewAmount: 100000,
    payments: { count: 0, grossPaid: 0, netPaid: 0, tdsDeducted: 0 },
  },
  staff: { active: 1, pendingInvitations: 0 },
  thresholds: { supplierApprovalSlaHours: 48, invoiceReviewAmount: 100000 },
  usage: {},
};

export const WORKSPACE_SETTINGS = {
  workspace: WORKSPACE_IDENTITY,
  groups: [],
};

export const EMPTY_WORKSPACE_API = {
  'GET /workspace/overview': WORKSPACE_OVERVIEW,
  'GET /workspace/settings': WORKSPACE_SETTINGS,
  'GET /workspace/audit': { entries: [], pagination: { total: 0, page: 1, limit: 50, pages: 0 }, filters: {} },
  'GET /vendors': emptyList('vendors'),
  'GET /rfqs': emptyList('rfqs'),
  'GET /pos': emptyList('pos'),
  'GET /invoices': emptyList('invoices'),
  'GET /payments': emptyList('payments'),
  'GET /users': { users: [] },
  'GET /users/roles': { roles: [] },
  'GET /users/invitations': { invitations: [] },
  'GET /payments/tds-summary': { rows: [], totals: { grossAmount: 0, tdsDeducted: 0, netAmount: 0 } },
};

// ---------------------------------------------------------------------------
// Platform console
// ---------------------------------------------------------------------------

// Both the health board and the SAP-connections board read this one
// endpoint; `tenants` is the per-tenant table under the summary tiles.
export const PLATFORM_HEALTH = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  windowHours: 24,
  platform: {
    tenants: { total: 0, byStatus: {} },
    sapFailing: 0,
    limitsBreached: 0,
  },
  tenants: [],
};

export const EMPTY_PLATFORM_API = {
  'GET /platform/health': PLATFORM_HEALTH,
  'GET /platform/tenants': { tenants: [] },
  'GET /platform/operators': { operators: [] },
  'GET /platform/audit': { entries: [], pagination: { total: 0, page: 1, limit: 50, pages: 0 } },
  'GET /platform/audit/filters': { actions: [], actors: [], subjects: [] },
  'GET /platform/reconciliation': { items: [], total: 0, slaHours: 24 },
};
