// The platform console's navigation registry — the only place its sections are
// listed. Each entry names the permission that reveals it; the layout filters
// against the permissions the API reports for the signed-in operator, so an
// sap_manager simply does not see Operators rather than seeing it and getting
// a 403.
//
// Permission strings mirror backend/config/permissions.js. They are declared
// here rather than fetched because a nav item is a static fact about a screen;
// who holds the permission is the part that comes from the server.

export const PLATFORM_NAV = [
  {
    href: '/platform',
    label: 'Overview',
    description: 'Tenant health, SAP status and usage',
    permission: 'platform:health:read',
    exact: true,
  },
  {
    href: '/platform/tenants',
    label: 'Tenants',
    description: 'Create, configure and offboard workspaces',
    permission: 'tenant:read',
  },
  {
    href: '/platform/operators',
    label: 'Operators',
    description: 'Platform accounts and their second factors',
    permission: 'operator:manage',
  },
  {
    href: '/platform/audit',
    label: 'Audit',
    description: 'Everything that happened, and who did it',
    permission: 'platform:audit:read',
  },
];

export const navFor = (permissions = []) =>
  PLATFORM_NAV.filter((item) => permissions.includes(item.permission));

export const isActive = (item, pathname) =>
  item.exact ? pathname === item.href : pathname.startsWith(item.href);
