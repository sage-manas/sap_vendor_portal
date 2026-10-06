import http from 'k6/http';
import { check, group, sleep, fail } from 'k6';
import { Trend, Rate } from 'k6/metrics';

// A k6 load test for the VendorConnect API (go-live item 3.x).
//
// Run it:
//   BASE_URL=https://staging.example.com \
//   SUPPLIER_LOGIN=supplier@example.com SUPPLIER_PASSWORD=... \
//   STAFF_LOGIN=buyer@example.com     STAFF_PASSWORD=... \
//   k6 run scripts/load-test.js
//
// ---------------------------------------------------------------------------
// WHAT THIS DELIBERATELY DOES NOT DO
// ---------------------------------------------------------------------------
//
// It is **read-only**. Every request below is a GET. That is not laziness; it
// is the only shape of load test this application can safely have today:
//
//  - A write to a tenant wired to a real SAP system reaches that system. CLT-0001
//    is connected to a live sandbox, and `createAssetPo` creates an actual
//    purchase order there. A load test that posted anything would create
//    hundreds of real documents in someone's SAP, and no amount of cleanup
//    afterwards would un-create them.
//  - Several reads are themselves SAP calls (`/pos/sap-status`,
//    `/invoices/sap-status`, the catalogue endpoints). Those are excluded too,
//    by default, for the same reason plus a second one: hammering a customer's
//    SAP gateway is how you trip their circuit breaker and take the portal
//    down for everyone on that tenant. Set INCLUDE_SAP=true only against a
//    tenant whose driver is `mock`.
//
// So this measures the portal's own hot path — auth, the dashboards, and the
// paginated document lists, which are what every navigation fetches (and see
// issue #127 on how many of those one navigation triggers). It does not
// measure SAP, and it cannot: SAP's latency is SAP's, and 22-84s for one
// endpoint (see sap/timeouts.js) would swamp every other number here.
//
// ---------------------------------------------------------------------------
// BEFORE YOU RUN IT
// ---------------------------------------------------------------------------
//
//  1. Point BASE_URL at a staging instance. Not production, and not a
//     developer's machine running `npm run dev` against the dev database.
//  2. Check the tenant's SAP driver is `mock`, or leave INCLUDE_SAP off.
//  3. Raise the rate limits, or you are load-testing express-rate-limit.
//     `apiLimiter` is 5000 requests / 15 min per IP and `tenantLimiter` 300 /
//     min per tenant (middleware/rateLimiter.js) — a load generator is one IP
//     and one tenant, so both will refuse you long before the app struggles.
//     Set API_RATE_LIMIT_MAX and TENANT_RATE_LIMIT_MAX high on the target, and
//     watch `rate_limited` below: if it is not ~0, your numbers mean nothing.

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const API = `${BASE_URL}/api`;

const INCLUDE_SAP = String(__ENV.INCLUDE_SAP || '').toLowerCase() === 'true';

// A 429 is not a server failure, but it does invalidate the run — tracked
// separately so a rate-limited run is visibly wrong rather than quietly fast.
const rateLimited = new Rate('rate_limited');
const loginDuration = new Trend('login_duration', true);
const listDuration = new Trend('list_duration', true);

export const options = {
  scenarios: {
    // Suppliers: many accounts, each doing a little. The shape of real
    // traffic — a supplier signs in, looks at their orders and invoices, and
    // leaves.
    suppliers: {
      executor: 'ramping-vus',
      exec: 'supplierJourney',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '2m', target: 25 },
        { duration: '1m', target: 25 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    // Staff: few accounts, each pulling tenant-wide lists, which are the
    // expensive reads (every supplier's rows, not one supplier's).
    staff: {
      executor: 'constant-vus',
      exec: 'staffJourney',
      vus: 3,
      duration: '4m',
      startTime: '30s',
    },
  },

  thresholds: {
    // Deliberately modest and explicitly provisional. These are starting
    // numbers to make the test fail loudly rather than a performance budget
    // anybody has agreed: this application has no measured baseline yet, and
    // inventing one here would be the same mistake as inventing a SAP
    // latency. Replace them with what staging actually does, then treat a
    // regression against *that* as the signal.
    http_req_failed: ['rate<0.01'],
    rate_limited: ['rate<0.01'],
    login_duration: ['p(95)<2000'],
    list_duration: ['p(95)<1500'],
    http_req_duration: ['p(95)<2000'],
  },
};

const required = (name) => {
  const value = __ENV[name];
  if (!value) fail(`${name} is required — see the header of this file`);
  return value;
};

const login = (identifier, password, label) => {
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({ vendorIdOrEmail: identifier, password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /auth/login' } },
  );

  loginDuration.add(res.timings.duration);
  rateLimited.add(res.status === 429);

  const ok = check(res, {
    [`${label} login succeeded`]: (r) => r.status === 200,
    [`${label} login returned a token`]: (r) => Boolean(r.json('token')),
  });

  // Without a token every subsequent request is a 401, and the run reports a
  // pile of fast failures that look like a different problem.
  if (!ok) fail(`${label} login failed with ${res.status} — check the credentials and the rate limits`);

  return res.json('token');
};

// The only write in this file, and it is the login above. Everything here is
// a GET; `name` tags group them so the summary is readable per endpoint
// rather than per URL with its query string.
const get = (token, path, name) => {
  const res = http.get(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name },
  });

  listDuration.add(res.timings.duration);
  rateLimited.add(res.status === 429);
  check(res, { [`${name} is 200`]: (r) => r.status === 200 });
  return res;
};

export function supplierJourney() {
  const token = login(required('SUPPLIER_LOGIN'), required('SUPPLIER_PASSWORD'), 'supplier');

  group('supplier portal', () => {
    // What portal-context.js fetches on sign-in. Issue #127 is about there
    // being this many; measuring them together is the point, because that is
    // what one navigation costs.
    get(token, '/auth/me', 'GET /auth/me');
    get(token, '/vendors/profile', 'GET /vendors/profile');
    get(token, '/dashboard/summary', 'GET /dashboard/summary');
    get(token, '/pos?limit=20', 'GET /pos');
    get(token, '/invoices?limit=20', 'GET /invoices');
    get(token, '/payments?limit=20', 'GET /payments');
    get(token, '/rfqs?limit=20', 'GET /rfqs');
    get(token, '/grns?limit=20', 'GET /grns');
    get(token, '/asns?limit=20', 'GET /asns');

    if (INCLUDE_SAP) {
      // Mock driver only — see the header.
      get(token, '/pos/sap-status', 'GET /pos/sap-status');
    }
  });

  // Real users read the page. Without this the test measures how fast k6 can
  // issue requests, not how the app behaves under a plausible arrival rate.
  sleep(Math.random() * 3 + 1);
}

export function staffJourney() {
  const token = login(required('STAFF_LOGIN'), required('STAFF_PASSWORD'), 'staff');

  group('workspace', () => {
    get(token, '/auth/me', 'GET /auth/me');
    get(token, '/workspace/overview', 'GET /workspace/overview');
    // Tenant-wide: every supplier's rows. The expensive ones, and the reason
    // the staff scenario exists separately.
    get(token, '/vendors?limit=50', 'GET /vendors');
    get(token, '/pos?limit=50', 'GET /pos');
    get(token, '/invoices?limit=50', 'GET /invoices');
    get(token, '/payments?limit=50', 'GET /payments');
    get(token, '/asns?limit=50', 'GET /asns');
    get(token, '/payments/tds-summary', 'GET /payments/tds-summary');
  });

  sleep(Math.random() * 2 + 1);
}

export function handleSummary(data) {
  const limited = data.metrics.rate_limited?.values?.rate ?? 0;
  const warning = limited > 0.01
    ? '\n  !! Rate limiting was hit. These numbers measure express-rate-limit, not the app.\n'
       + '     Raise API_RATE_LIMIT_MAX and TENANT_RATE_LIMIT_MAX on the target and run again.\n'
    : '';

  return {
    stdout: `${warning}\n  Target: ${BASE_URL}  (SAP reads ${INCLUDE_SAP ? 'INCLUDED' : 'excluded'})\n`,
    'load-test-summary.json': JSON.stringify(data, null, 2),
  };
}
