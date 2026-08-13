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

export const navFor = (permissions = []) =>
  WORKSPACE_NAV.filter((item) => permissions.includes(item.permission));

export const isActive = (item, pathname) =>
  (item.exact ? pathname === item.href : pathname.startsWith(item.href));
