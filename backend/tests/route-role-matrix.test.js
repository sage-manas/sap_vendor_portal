const routes = require('../routes/index');
const { ALL_ROLES, planeOf, PLANES } = require('../config/roles');
const {
  ALL_PERMISSIONS,
  hasPermission,
  rolesWithPermission,
  permissionsFor,
} = require('../config/permissions');

// The generated route × role matrix.
//
// It walks the real Express router, so a route added without a permission
// declaration fails CI on the commit that adds it — there is no list here to
// forget to update.

// Endpoints that establish identity: there is no principal yet, so there is
// nothing to authorize. Every entry is a deliberate, reviewed exception.
const PUBLIC_ROUTES = new Set([
  'GET /health',
  'GET /status',
  'GET /test-error',
  'GET /auth/workspace',
  'POST /auth/register',
  'POST /auth/login',
  'POST /auth/forgot-password',
  'POST /auth/reset-password',
  'GET /auth/invitations/:token',
  'POST /auth/invitations/accept',
  'POST /vendors/profile',
  'POST /platform/auth/login',
  'POST /platform/auth/forgot-password',
  'POST /platform/auth/reset-password',
]);

// Walks an Express router tree and yields { method, path, permission }.
//
// Express 5 keeps a mount path only inside each layer's matcher closure, so the
// prefix is recovered by asking the matcher itself: the mount candidates come
// from the `router.use('/x', …)` calls in routes/index.js, and the matching one
// is the layer's prefix. No hand-maintained mount table.
const MOUNT_CANDIDATES = [...require('fs')
  .readFileSync(require.resolve('../routes/index'), 'utf8')
  .matchAll(/router\.use\('(\/[^']*)'/g)]
  .map((match) => match[1]);

const collectRoutes = (router, prefix = '') => {
  const found = [];

  const layerPath = (layer) => {
    if (layer.route) return layer.route.path;
    const matcher = layer.matchers?.[0];
    if (!matcher) return '';
    const mount = MOUNT_CANDIDATES.find((candidate) => matcher(candidate));
    return mount || '';
  };

  for (const layer of router.stack || []) {
    if (layer.route) {
      const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
      const handlers = layer.route.stack.map((s) => s.handle);
      const permission = handlers.map((h) => h.permission).find(Boolean) || null;

      for (const method of Object.keys(layer.route.methods)) {
        found.push({ method: method.toUpperCase(), path, permission });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      found.push(...collectRoutes(layer.handle, `${prefix}${layerPath(layer)}`.replace(/\/$/, '')));
    }
  }

  return found;
};

const allRoutes = collectRoutes(routes);
const key = (route) => `${route.method} ${route.path}`;

describe('route × role matrix', () => {
  it('finds the whole API surface', () => {
    expect(allRoutes.length).toBeGreaterThan(30);
  });

  it('every route either declares a permission or is a reviewed public route', () => {
    const undeclared = allRoutes
      .filter((route) => !route.permission && !PUBLIC_ROUTES.has(key(route)))
      .map(key);

    expect(undeclared).toEqual([]);
  });

  it('no route declares a permission that no role holds', () => {
    const orphaned = allRoutes
      .filter((route) => route.permission && rolesWithPermission(route.permission).length === 0)
      .map((route) => `${key(route)} → ${route.permission}`);

    expect(orphaned).toEqual([]);
  });

  it('every declared permission exists in the registry', () => {
    const unknown = allRoutes
      .filter((route) => route.permission && !ALL_PERMISSIONS.includes(route.permission))
      .map((route) => `${key(route)} → ${route.permission}`);

    expect(unknown).toEqual([]);
  });

  it('a route listed as public is really unguarded, and vice versa', () => {
    const declaredButListedPublic = allRoutes
      .filter((route) => route.permission && PUBLIC_ROUTES.has(key(route)))
      .map(key);

    expect(declaredButListedPublic).toEqual([]);
  });

  // The plan's hard rule: platform roles hold no tenant business data.
  it('platform roles hold no tenant-plane permission beyond self:read', () => {
    const platformRoles = ALL_ROLES.filter((role) => planeOf(role) === PLANES.PLATFORM);

    for (const role of platformRoles) {
      const leaked = permissionsFor(role).filter((permission) => {
        if (permission === 'self:read') return false;
        // A tenant-plane permission is one some tenant or supplier role holds.
        return rolesWithPermission(permission).some((holder) => planeOf(holder) !== PLANES.PLATFORM);
      });

      expect({ role, leaked }).toEqual({ role, leaked: [] });
    }
  });

  it('tenant and supplier roles hold no platform permission', () => {
    const platformOnly = ALL_PERMISSIONS.filter(
      (permission) =>
        rolesWithPermission(permission).length > 0 &&
        rolesWithPermission(permission).every((role) => planeOf(role) === PLANES.PLATFORM)
    );

    for (const role of ALL_ROLES.filter((r) => planeOf(r) !== PLANES.PLATFORM)) {
      const leaked = platformOnly.filter((permission) => hasPermission(role, permission));
      expect({ role, leaked }).toEqual({ role, leaked: [] });
    }
  });

  it('a supplier cannot create, manage or award sourcing documents', () => {
    for (const permission of ['rfq:create', 'rfq:manage', 'rfq:award', 'po:create', 'vendor:approve', 'user:invite']) {
      expect(hasPermission('vendor', permission)).toBe(false);
    }
  });

  it('only client_admin manages staff and approves suppliers', () => {
    for (const permission of ['user:invite', 'user:manage', 'vendor:approve', 'vendor:invite']) {
      expect(rolesWithPermission(permission)).toEqual(['client_admin']);
    }
  });

  it('every role holds at least one permission', () => {
    for (const role of ALL_ROLES) {
      expect(permissionsFor(role).length).toBeGreaterThan(0);
    }
  });
});
