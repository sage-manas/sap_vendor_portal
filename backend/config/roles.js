// The single registry of roles and the plane each one belongs to.
// Nothing anywhere else may hard-code a role list — guards, JWTs, seeds and
// (later) nav all read from here. Phase 2 widens the tenant plane to
// client_admin / buyer / finance and adds the platform plane's operators.

const PLANES = {
  PLATFORM: 'platform',
  TENANT:   'tenant',
  SUPPLIER: 'supplier',
};

// role → plane
const ROLE_PLANE = {
  // Platform plane (Phase 2 — no accounts hold these yet)
  super_admin: PLANES.PLATFORM,
  sap_manager: PLANES.PLATFORM,

  // Tenant plane. 'admin' is today's tenant administrator; Phase 2 renames it
  // to client_admin and adds buyer / finance alongside it.
  admin: PLANES.TENANT,

  // Supplier plane
  vendor: PLANES.SUPPLIER,
};

const ALL_ROLES = Object.keys(ROLE_PLANE);

const planeOf = (role) => ROLE_PLANE[role] || null;

const isPlatformRole = (role) => planeOf(role) === PLANES.PLATFORM;

// Platform roles carry clientId: null and may never reach tenant endpoints.
const requiresTenant = (role) => Boolean(planeOf(role)) && !isPlatformRole(role);

module.exports = { PLANES, ROLE_PLANE, ALL_ROLES, planeOf, isPlatformRole, requiresTenant };
