// The single registry of what each role may do. Routes declare a permission
// (see middleware/auth.js `requirePermission`); this file decides who holds it.
// Adding a role means editing exactly one map here — never a route file.

const { ROLES, ALL_ROLES, planeOf } = require('./roles');

const P = {
  // Own account
  SELF_READ: 'self:read',

  // Supplier's own onboarding record
  PROFILE_READ: 'profile:read',
  PROFILE_WRITE: 'profile:write',
  PROFILE_SUBMIT: 'profile:submit',

  // Supplier directory (tenant side)
  VENDOR_READ: 'vendor:read',
  VENDOR_APPROVE: 'vendor:approve',
  VENDOR_INVITE: 'vendor:invite',
  PERFORMANCE_READ: 'performance:read',

  // Sourcing
  RFQ_READ: 'rfq:read',
  RFQ_CREATE: 'rfq:create',
  RFQ_MANAGE: 'rfq:manage',
  RFQ_BID: 'rfq:bid',
  RFQ_EVALUATE: 'rfq:evaluate',
  RFQ_AWARD: 'rfq:award',

  // Purchase orders and shipping
  PO_READ: 'po:read',
  PO_CREATE: 'po:create',
  PO_MANAGE: 'po:manage',
  PO_ACKNOWLEDGE: 'po:acknowledge',
  ASN_READ: 'asn:read',
  ASN_CREATE: 'asn:create',
  GRN_READ: 'grn:read',

  // Finance
  INVOICE_READ: 'invoice:read',
  INVOICE_SUBMIT: 'invoice:submit',
  INVOICE_APPROVE: 'invoice:approve',
  INVOICE_POST: 'invoice:post',
  PAYMENT_READ: 'payment:read',
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_MANAGE: 'payment:manage',

  // Collaboration and content
  CHAT_READ: 'chat:read',
  CHAT_WRITE: 'chat:write',
  DOCUMENT_READ: 'document:read',
  DOCUMENT_WRITE: 'document:write',
  DOCUMENT_DELETE: 'document:delete',

  // Reporting
  REPORT_READ: 'report:read',
  REPORT_METRICS: 'report:metrics',
  DASHBOARD_READ: 'dashboard:read',
  SAPLOG_READ: 'saplog:read',

  // Tenant administration
  USER_READ: 'user:read',
  USER_INVITE: 'user:invite',
  USER_MANAGE: 'user:manage',

  // Platform plane
  TENANT_READ: 'tenant:read',
  TENANT_MANAGE: 'tenant:manage',
  OPERATOR_MANAGE: 'operator:manage',
  PLATFORM_AUDIT_READ: 'platform:audit:read',
  SAP_CONFIGURE: 'sap:configure',
};

// Grants that every authenticated principal holds, on any plane.
const COMMON = [P.SELF_READ];

// Read access shared by all three tenant-plane roles.
const TENANT_READ_ONLY = [
  P.VENDOR_READ,
  P.PERFORMANCE_READ,
  P.RFQ_READ,
  P.PO_READ,
  P.ASN_READ,
  P.GRN_READ,
  P.INVOICE_READ,
  P.PAYMENT_READ,
  P.CHAT_READ,
  P.CHAT_WRITE,
  P.DOCUMENT_READ,
  P.REPORT_READ,
  P.REPORT_METRICS,
  P.DASHBOARD_READ,
  P.SAPLOG_READ,
];

const BUYER = [
  ...TENANT_READ_ONLY,
  P.RFQ_CREATE,
  P.RFQ_MANAGE,
  P.RFQ_EVALUATE,
  P.RFQ_AWARD,
  P.PO_CREATE,
  P.PO_MANAGE,
  P.DOCUMENT_WRITE,
];

const FINANCE = [
  ...TENANT_READ_ONLY,
  P.INVOICE_APPROVE,
  P.INVOICE_POST,
  P.PAYMENT_CREATE,
  P.PAYMENT_MANAGE,
  P.DOCUMENT_WRITE,
];

// The tenant administrator is a superset of buyer + finance, plus the things
// only they may do: supplier approval and staff management.
const CLIENT_ADMIN = [
  ...new Set([
    ...BUYER,
    ...FINANCE,
    P.VENDOR_APPROVE,
    P.VENDOR_INVITE,
    P.DOCUMENT_DELETE,
    P.USER_READ,
    P.USER_INVITE,
    P.USER_MANAGE,
  ]),
];

const VENDOR = [
  P.PROFILE_READ,
  P.PROFILE_WRITE,
  P.PROFILE_SUBMIT,
  P.PERFORMANCE_READ,
  P.RFQ_READ,
  P.RFQ_BID,
  P.PO_READ,
  P.PO_ACKNOWLEDGE,
  P.ASN_READ,
  P.ASN_CREATE,
  P.GRN_READ,
  P.INVOICE_READ,
  P.INVOICE_SUBMIT,
  P.PAYMENT_READ,
  P.CHAT_READ,
  P.CHAT_WRITE,
  P.DOCUMENT_READ,
  P.DOCUMENT_WRITE,
  P.REPORT_READ,
  P.DASHBOARD_READ,
  P.SAPLOG_READ,
];

// Platform roles get tenant *configuration* only. There is deliberately no
// overlap with the tenant business permissions above: an operator holding
// rfq:read would be a bug, and the route×role matrix test asserts it stays that
// way.
const SUPER_ADMIN = [
  P.TENANT_READ,
  P.TENANT_MANAGE,
  P.OPERATOR_MANAGE,
  P.PLATFORM_AUDIT_READ,
  P.SAP_CONFIGURE,
];

const SAP_MANAGER = [
  P.TENANT_READ,
  P.PLATFORM_AUDIT_READ,
  P.SAP_CONFIGURE,
];

const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [...COMMON, ...SUPER_ADMIN],
  [ROLES.SAP_MANAGER]: [...COMMON, ...SAP_MANAGER],
  [ROLES.CLIENT_ADMIN]: [...COMMON, ...CLIENT_ADMIN],
  [ROLES.BUYER]: [...COMMON, ...BUYER],
  [ROLES.FINANCE]: [...COMMON, ...FINANCE],
  [ROLES.VENDOR]: [...COMMON, ...VENDOR],
};

const ALL_PERMISSIONS = Object.values(P);

const permissionsFor = (role) => ROLE_PERMISSIONS[role] || [];

const hasPermission = (role, permission) => permissionsFor(role).includes(permission);

// Every role that holds a permission — used by the matrix test and, later, by
// the nav registry.
const rolesWithPermission = (permission) =>
  ALL_ROLES.filter((role) => hasPermission(role, permission));

// The plane a permission belongs to, derived rather than declared: a permission
// no role holds is a typo, and this returns null for it.
const planeOfPermission = (permission) => {
  const holders = rolesWithPermission(permission);
  if (!holders.length) return null;
  const planes = new Set(holders.map(planeOf));
  return planes.has('platform') && planes.size > 1 ? 'mixed' : planes.values().next().value;
};

module.exports = {
  PERMISSIONS: P,
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  permissionsFor,
  hasPermission,
  rolesWithPermission,
  planeOfPermission,
};
