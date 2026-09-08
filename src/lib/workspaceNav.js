// The tenant back office's navigation registry — the only place its sections
// are listed. Each entry names the permission that reveals it; the layout
// filters against the permissions the API reports for the signed-in account, so
// a buyer simply does not see Settings rather than seeing it and getting a 403.
//
// Same contract as platformNav.js, different plane. Permission strings mirror
// backend/config/permissions.js: a nav item is a static fact about a screen,
// and who holds the permission is the part that comes from the server.

export const WORKSPACE_ROOT = '/workspace';

export const WORKSPACE_NAV = [
  {
    href: '/workspace',
    label: 'Overview',
    description: 'What needs a decision today',
    permission: 'workspace:read',
    exact: true,
  },
  {
    href: '/workspace/suppliers',
    label: 'Suppliers',
    description: 'The directory, and the approval queue',
    permission: 'vendor:read',
  },
  {
    href: '/workspace/rfqs',
    label: 'RFQs',
    description: 'Every request for quotation, across every supplier',
    permission: 'rfq:read',
  },
  {
    href: '/workspace/purchase-orders',
    label: 'Purchase Orders',
    description: 'Every order this workspace has raised, and their invoicing plans',
    permission: 'po:read',
  },
  {
    href: '/workspace/invoices',
    label: 'Invoices',
    description: 'Every invoice submitted, across every supplier',
    permission: 'invoice:read',
  },
  {
    href: '/workspace/payments',
    label: 'Payments',
    description: 'Settlements and TDS deducted, across every supplier',
    permission: 'payment:read',
  },
  {
    href: '/workspace/users',
    label: 'Users',
    description: 'Buyers, finance and administrators',
    permission: 'user:read',
  },
  {
    href: '/workspace/settings',
    label: 'Settings',
    description: 'Branding, features, thresholds and notifications',
    permission: 'settings:manage',
  },
  {
    href: '/workspace/audit',
    label: 'Audit',
    description: 'Everything that happened in this workspace',
    permission: 'audit:read',
  },
];

// Permission strings are shared vocabulary across planes on purpose —
// `po:read`/`rfq:read`/`invoice:read`/`payment:read` mean "may read this kind
// of data" whether that is a supplier's own single-vendor view or a tenant
// staff member's tenant-wide one (backend/config/permissions.js). A supplier
// holds several of these for their own portal, so filtering on the permission
// string alone would show them workspace tabs their account was never meant
// to reach. `plane` is the second, non-bypassable check: it comes from the
// server-verified JWT (`session.auth.plane` in workspace-session.js), not
// anything a client could spoof, and nothing renders unless it is exactly
// `'tenant'` — fail closed rather than trust the permission list alone.
export const navFor = (permissions = [], plane) =>
  (plane !== 'tenant' ? [] : WORKSPACE_NAV.filter((item) => permissions.includes(item.permission)));

export const isActive = (item, pathname) =>
  (item.exact ? pathname === item.href : pathname.startsWith(item.href));
