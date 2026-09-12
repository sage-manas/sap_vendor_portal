import { Suspense } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';

import { ThemeProvider } from '@/lib/theme-context';
import { ShellProvider } from '@/lib/shell-context';
import { PortalProvider } from '@/lib/portal-context';
import { WorkspaceSessionProvider } from '@/lib/workspace-session';
import { PlatformSessionProvider } from '@/lib/platform-session';
import { navigation, socketRef, resetNavigation } from './testState';

// The harness PROJECT_CONTEXT.md §10 recorded as the blocker on every
// component, page and flow test: "Route/component smoke tests deferred (need a
// mocked PortalProvider with fetch + socket.io)".
//
// The seam is `fetch`, not the modules above it. Stubbing api-client.js or
// platform-client.js would skip the code that builds the request, attaches the
// token, and turns a non-2xx body into an error carrying `errors`/`reason` —
// which is exactly the code a form test needs to be real. So a test declares
// what the SERVER says, and everything between the component and the wire runs
// for real.
//
// Usage:
//
//   renderWithPortal(<RfqsPage />, {
//     plane: 'supplier',
//     api: { 'GET /rfqs': { rfqs: [] } },
//   });

// ---------------------------------------------------------------------------
// The fetch stub
// ---------------------------------------------------------------------------

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

// A route key is "<METHOD> <path>", where the path is what the caller passed
// api-client (so '/rfqs', not '/api/rfqs'). The platform client's own
// '/platform' prefix is part of the path: 'GET /platform/tenants'.
const routeKey = (method, path) => `${method.toUpperCase()} ${path}`;

const normalisePath = (url) => {
  const path = String(url).startsWith(BASE_URL) ? String(url).slice(BASE_URL.length) : String(url);
  // Query strings are not part of the key: a test that cares about them reads
  // `apiMock.calls` instead of encoding them into every route it declares.
  return path.split('?')[0];
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * Installs a `fetch` that answers from a route table.
 *
 * A route's value is either the JSON body to return with 200, or
 * `{ status, body }` for anything else — which is how a test exercises the
 * validation-error path (`{ status: 400, body: { errors: { gstin: '…' } } }`)
 * or a refusal (`{ status: 403, body: { reason: 'mfa_enrolment_required' } }`).
 * A function value is called with `{ method, path, body, url }`.
 *
 * An unlisted route answers 404 and is recorded — `apiMock.unmatched` is what
 * turns "the page rendered empty for a reason I did not expect" into a
 * readable failure.
 */
export const mockApi = (routes = {}) => {
  const calls = [];
  const unmatched = [];

  const fetchStub = vi.fn(async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const path = normalisePath(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path, body, url: String(url), headers: options.headers || {} });

    const route = routes[routeKey(method, path)];
    if (route === undefined) {
      unmatched.push(routeKey(method, path));
      return jsonResponse(404, { error: `No mock for ${routeKey(method, path)}` });
    }

    const resolved = typeof route === 'function' ? await route({ method, path, body, url }) : route;
    if (resolved && typeof resolved === 'object' && 'status' in resolved && 'body' in resolved) {
      return jsonResponse(resolved.status, resolved.body);
    }
    return jsonResponse(200, resolved);
  });

  vi.stubGlobal('fetch', fetchStub);

  return {
    fetchStub,
    calls,
    unmatched,
    /** Every call to one route, in order — for asserting a submitted payload. */
    callsTo: (method, path) =>
      calls.filter((call) => call.method === method.toUpperCase() && call.path === path),
    /** The body of the last call to one route. */
    lastBody: (method, path) => {
      const matching = calls.filter(
        (call) => call.method === method.toUpperCase() && call.path === path
      );
      return matching.length ? matching[matching.length - 1].body : undefined;
    },
  };
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SUPPLIER_SESSION = {
  auth: {
    id: 'vendor-1',
    role: 'vendor',
    plane: 'supplier',
    email: 'supplier@example.com',
    permissions: ['profile:read', 'rfq:read', 'rfq:bid', 'po:read', 'invoice:submit', 'payment:read'],
    mustChangePassword: false,
  },
  workspace: { clientId: 'CLT-0001', companyName: 'Nucleus Manufacturing', branding: {} },
};

export const TENANT_SESSION = {
  auth: {
    id: 'user-1',
    role: 'client_admin',
    plane: 'tenant',
    email: 'admin@example.com',
    permissions: [
      'vendor:read', 'vendor:approve', 'rfq:read', 'rfq:create', 'rfq:manage', 'rfq:award',
      'po:read', 'invoice:read', 'invoice:approve', 'payment:read', 'user:manage',
      'settings:manage', 'audit:read',
    ],
    mustChangePassword: false,
  },
  user: { id: 'user-1', name: 'Test Admin', email: 'admin@example.com', role: 'client_admin' },
  workspace: { clientId: 'CLT-0001', companyName: 'Nucleus Manufacturing', branding: {}, settings: {} },
};

export const OPERATOR_SESSION = {
  operator: { id: 'op-1', name: 'Test Operator', email: 'operator@example.com', role: 'super_admin' },
  auth: {
    plane: 'platform',
    role: 'super_admin',
    permissions: ['platform:tenants', 'platform:operators', 'platform:sap', 'platform:audit', 'platform:health'],
  },
  mustChangePassword: false,
  // stageFor() in lib/platform-session.js walks mustChangePassword → enrolled →
  // verified before it will render the console, so a console test has to be
  // past all three.
  mfa: { enrolled: true, verified: true },
};

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

/**
 * The `params` a dynamic route expects.
 *
 * Next hands a page a promise, which the page unwraps with React's `use()`.
 * A plain `Promise.resolve(...)` never settles under the test renderer — the
 * component suspends and nothing retries it — so this hands over the shape
 * `use()` reads synchronously instead: an already-fulfilled thenable, which is
 * what Next's own promise has become by the time a client page renders.
 *
 *   <TenantDetailPage params={routeParams({ clientId: 'CLT-0001' })} />
 */
export const routeParams = (value) => ({
  status: 'fulfilled',
  value,
  then: (onFulfilled) => onFulfilled(value),
});

// A dynamic route receives `params` as a promise and unwraps it with React's
// `use()`, which suspends. Next renders every page inside a boundary; without
// one here such a page suspends forever and renders nothing at all — no error,
// just an empty body.
const Boundary = ({ children }) => <Suspense fallback={<div>Suspended</div>}>{children}</Suspense>;

const PLANES = {
  supplier: ({ children }) => (
    <ThemeProvider>
      <ShellProvider>
        <PortalProvider><Boundary>{children}</Boundary></PortalProvider>
      </ShellProvider>
    </ThemeProvider>
  ),
  // The workspace and platform route groups have their own layout, session and
  // token — mirrored here rather than flattened, so a page sees the same
  // provider stack it sees in the app. The layout's own chrome (nav, header)
  // is deliberately NOT included: it is not what a page test is about, and
  // rendering it would make every page assertion ambiguous between the nav
  // link and the page body.
  workspace: ({ children }) => (
    <ThemeProvider>
      <WorkspaceSessionProvider><Boundary>{children}</Boundary></WorkspaceSessionProvider>
    </ThemeProvider>
  ),
  platform: ({ children }) => (
    <ThemeProvider>
      <PlatformSessionProvider><Boundary>{children}</Boundary></PlatformSessionProvider>
    </ThemeProvider>
  ),
  /** No providers — for a component tested in isolation. */
  bare: ({ children }) => <ThemeProvider><Boundary>{children}</Boundary></ThemeProvider>,
};

/** The session route every plane resolves itself through, pre-filled. */
export const sessionRoutes = (plane) => {
  if (plane === 'platform') return { 'GET /platform/auth/me': OPERATOR_SESSION };
  if (plane === 'workspace') return { 'GET /auth/me': TENANT_SESSION };
  return { 'GET /auth/me': SUPPLIER_SESSION };
};

/**
 * Renders `ui` inside the provider stack its plane gives it in the real app.
 *
 * @param {object} [options]
 * @param {'supplier'|'workspace'|'platform'|'bare'} [options.plane]
 * @param {string}  [options.route]   the pathname components read
 * @param {object}  [options.params]  Next dynamic route params
 * @param {object}  [options.api]     route table, merged over the session route
 * @param {object}  [options.session] overrides the plane's default session
 * @param {boolean} [options.signedOut] render with no token at all
 */
export const renderWithPortal = (ui, options = {}) => {
  const {
    plane = 'supplier',
    route = '/',
    params = {},
    api = {},
    session,
    signedOut = false,
  } = options;

  resetNavigation(route, params);

  if (!signedOut) {
    // Both clients read their token from localStorage before they will ask who
    // the caller is; without one the providers settle on "signed out" and no
    // page renders.
    localStorage.setItem('jwt_token', 'test-token');
    localStorage.setItem('vc_platform_token', 'test-platform-token');
  }

  const defaults = signedOut ? {} : sessionRoutes(plane);
  if (session) {
    const key = plane === 'platform' ? 'GET /platform/auth/me' : 'GET /auth/me';
    defaults[key] = session;
  }

  const apiMock = mockApi({ ...defaults, ...api });
  // Replaced per test by setup.jsx's beforeEach; handed back so a test can
  // push server events at the UI it just rendered.
  const socket = socketRef.current;
  const Wrapper = PLANES[plane];

  const result = render(ui, { wrapper: Wrapper });

  return { ...result, apiMock, socket, navigation };
};

export { render };

export { navigation, resetNavigation };
