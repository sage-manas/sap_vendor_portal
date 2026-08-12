// The single registry of roles, the plane each one belongs to, and the identity
// collection that stores it. Nothing anywhere else may hard-code a role list —
// guards, JWTs, seeds, invitations and (later) nav all read from here.
//
// Three planes, and they never mix:
//   platform — operates on tenant *configuration*, holds no tenant business data
//   tenant   — the client's own staff, scoped to exactly one clientId
//   supplier — a vendor logging in to one client's workspace

const PLANES = {
  PLATFORM: 'platform',
  TENANT: 'tenant',
  SUPPLIER: 'supplier',
};

// Which collection holds accounts for a plane. `protect` uses this to decide
// where to look up a token's subject, so a token can never resolve an account
// from another plane's collection.
const PLANE_ACCOUNT_MODEL = {
  [PLANES.PLATFORM]: 'PlatformUser',
  [PLANES.TENANT]: 'User',
  [PLANES.SUPPLIER]: 'Vendor',
};

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  SAP_MANAGER: 'sap_manager',
  CLIENT_ADMIN: 'client_admin',
  BUYER: 'buyer',
  FINANCE: 'finance',
  VENDOR: 'vendor',
};

// role → plane
const ROLE_PLANE = {
  [ROLES.SUPER_ADMIN]: PLANES.PLATFORM,
  [ROLES.SAP_MANAGER]: PLANES.PLATFORM,

  [ROLES.CLIENT_ADMIN]: PLANES.TENANT,
  [ROLES.BUYER]: PLANES.TENANT,
  [ROLES.FINANCE]: PLANES.TENANT,

  [ROLES.VENDOR]: PLANES.SUPPLIER,
};

const ALL_ROLES = Object.keys(ROLE_PLANE);

const rolesInPlane = (plane) => ALL_ROLES.filter((role) => ROLE_PLANE[role] === plane);

const PLATFORM_ROLES = rolesInPlane(PLANES.PLATFORM);
const TENANT_ROLES = rolesInPlane(PLANES.TENANT);
const SUPPLIER_ROLES = rolesInPlane(PLANES.SUPPLIER);

const planeOf = (role) => ROLE_PLANE[role] || null;

const isPlatformRole = (role) => planeOf(role) === PLANES.PLATFORM;

// Platform roles carry clientId: null and may never reach tenant endpoints.
const requiresTenant = (role) => Boolean(planeOf(role)) && !isPlatformRole(role);

const accountModelForRole = (role) => PLANE_ACCOUNT_MODEL[planeOf(role)] || null;

// Roles a tenant may hand out from its own workspace (Phase 5's user management
// screen reads this; the invite endpoint validates against it).
const INVITABLE_TENANT_ROLES = TENANT_ROLES;

module.exports = {
  PLANES,
  ROLES,
  ROLE_PLANE,
  ALL_ROLES,
  PLATFORM_ROLES,
  TENANT_ROLES,
  SUPPLIER_ROLES,
  INVITABLE_TENANT_ROLES,
  PLANE_ACCOUNT_MODEL,
  planeOf,
  isPlatformRole,
  requiresTenant,
  rolesInPlane,
  accountModelForRole,
};
