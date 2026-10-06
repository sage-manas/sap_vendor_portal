const request = require('supertest');
const buildTestApp = require('./testApp');
const { allRoutes } = require('./routeTable');
const { paginationSchema } = require('../validators/pagination.validator');
const { createAdminUser, createOperatorSession } = require('./helpers');

const app = buildTestApp();

// Every GET route is accounted for here, so a list endpoint added without
// pagination fails on the commit that adds it. There is no list to forget to
// update in the way that matters: a new route is in none of the sets below,
// and the first test names it.
//
// A list route is guarded when validateQuery(paginationSchema) is on it —
// `page`/`limit` are numbers, `limit` is at most 200, and everything else in
// the query string passes through (validators/pagination.validator.js, #118).

const key = (route) => `${route.method} ${route.path}`;
const isPaginated = (route) => route.handlers.some((handler) => handler.schema === paginationSchema);

// Not a collection: a single document, a scalar, a generated file or a fixed
// catalogue.
const NOT_A_LIST = new Set([
  'GET /health', 'GET /test-error', 'GET /status', 'GET /meta/sap-fields',
  // A fixed 37-row reference list (config/indianStates.js, finding 4.4), not
  // a collection that grows with a tenant's data -- the same reason
  // /meta/sap-fields is here.
  'GET /meta/indian-states',
  'GET /auth/workspace', 'GET /auth/me', 'GET /auth/invitations/:token',
  'GET /platform/auth/me', 'GET /platform/health',
  'GET /platform/tenants/:clientId', 'GET /platform/tenants/:clientId/export', 'GET /platform/tenants/:clientId/sap',
  'GET /vendors/profile', 'GET /vendors/sap-reference-data', 'GET /vendors/performance', 'GET /vendors/:id',
  'GET /workspace/overview', 'GET /workspace/settings',
  'GET /users/roles', 'GET /users/:id',
  'GET /rfqs/:id', 'GET /rfqs/:id/evaluate', 'GET /rfqs/:id/export',
  'GET /pos/:id', 'GET /pos/:id/invoice-plan', 'GET /pos/:id/asn',
  'GET /grns/:id', 'GET /invoices/:id', 'GET /payments/:id', 'GET /payments/tds-summary',
  'GET /uploads/:id', 'GET /uploads/:id/link', 'GET /uploads/signed/:id', 'GET /reports/statement', 'GET /reports/invoice/:id', 'GET /reports/metrics',
  'GET /dashboard/summary',
]);

// Lists that read `page`/`limit` themselves and clamp them in the controller
// (so a hostile value cannot reach Prisma). They keep their own defaults, and
// the SAP status lists treat "no page" as "the whole set", so the shared schema
// (default limit 20) would change what they answer.
const HAND_BOUNDED = new Set([
  'GET /platform/audit',   // auditQuery(): at most 200
  'GET /workspace/audit',  // auditQuery(…, 100): at most 100
  'GET /pos/sap-status',   // at most 100 once a page is asked for
  'GET /invoices/sap-status', // at most 100
  'GET /logs',             // a fixed most-recent 100
]);

// Known-imperfect: these return every matching row. Tracked in
// https://github.com/sage-manas/sap_vendor_portal/issues/186 — that issue owns
// the response-shape change. Do not add a route here without a reason; adding
// one is the decision the test exists to make visible.
const UNPAGINATED_ISSUE_186 = new Set([
  'GET /uploads',
  'GET /users',
  'GET /users/invitations',
  'GET /asns',
  'GET /rfqs/sap-status',
  'GET /rfqs/sap-quotations',
  'GET /payments/sap-status',
  'GET /platform/operators',
  'GET /platform/reconciliation',
  'GET /platform/audit/filters',
]);

const getRoutes = allRoutes.filter((route) => route.method === 'GET');

describe('every GET route is paginated or a reviewed exception', () => {
  it('no GET route is unaccounted for', () => {
    const unaccounted = getRoutes
      .filter((route) => !isPaginated(route))
      .map(key)
      .filter((route) => ![NOT_A_LIST, HAND_BOUNDED, UNPAGINATED_ISSUE_186].some((set) => set.has(route)));

    expect(unaccounted).toEqual([]);
  });

  it('the reviewed sets name no route that does not exist, and none that is already paginated', () => {
    const existing = new Set(getRoutes.map(key));
    const paginated = new Set(getRoutes.filter(isPaginated).map(key));
    const stale = [NOT_A_LIST, HAND_BOUNDED, UNPAGINATED_ISSUE_186]
      .flatMap((set) => [...set])
      .filter((route) => !existing.has(route) || paginated.has(route));

    expect(stale).toEqual([]);
  });

  it('a route is in at most one set', () => {
    const all = [NOT_A_LIST, HAND_BOUNDED, UNPAGINATED_ISSUE_186].flatMap((set) => [...set]);
    expect(all.filter((route, index) => all.indexOf(route) !== index)).toEqual([]);
  });

  it('the paginated routes are the six main tenant lists and three platform lists', () => {
    expect(getRoutes.filter(isPaginated).map(key).sort()).toEqual([
      'GET /grns', 'GET /invoices', 'GET /payments', 'GET /platform/jobs',
      'GET /platform/tenants', 'GET /platform/tenants/:clientId/sap/audit',
      'GET /pos', 'GET /rfqs', 'GET /vendors',
    ]);
  });

  // Static presence is not enough: this asks each one for more than the
  // ceiling, and for something that is not a number.
  describe('and each refuses an oversized or non-numeric limit', () => {
    const paginated = getRoutes.filter(isPaginated);
    let tenantToken;
    let operatorToken;

    beforeEach(async () => {
      tenantToken = (await createAdminUser()).token;
      operatorToken = (await createOperatorSession()).token;
    });

    it.each(paginated.map((route) => [key(route), route.path]))('%s', async (_label, path) => {
      const url = `/api${path.replace(':clientId', 'CLT-0001')}`;
      const token = path.startsWith('/platform') ? operatorToken : tenantToken;

      const tooMany = await request(app).get(`${url}?limit=1000000`).set('Authorization', `Bearer ${token}`);
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.errors).toHaveProperty('limit');

      const notANumber = await request(app).get(`${url}?limit=abc`).set('Authorization', `Bearer ${token}`);
      expect(notANumber.status).toBe(400);
    });
  });
});
