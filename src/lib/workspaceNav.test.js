import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { WORKSPACE_NAV, navFor, isActive } from './workspaceNav';

// Same reasoning as platformNav.test.js: the registry names permissions the
// backend defines, and a typo'd permission hides a tab from everyone silently.
// So the test reaches across to the real map rather than a copy of it.
const require = createRequire(import.meta.url);
const { ALL_PERMISSIONS, permissionsFor } = require('../../backend/config/permissions');
const { ROLES, planeOf } = require('../../backend/config/roles');

describe('the workspace nav registry', () => {
  it('names only permissions the backend actually grants', () => {
    for (const item of WORKSPACE_NAV) {
      expect(ALL_PERMISSIONS, `${item.href} declares an unknown permission`).toContain(item.permission);
    }
  });

  it('shows a client_admin the whole back office', () => {
    const admin = navFor(permissionsFor(ROLES.CLIENT_ADMIN), planeOf(ROLES.CLIENT_ADMIN)).map((item) => item.href);
    expect(admin).toEqual(WORKSPACE_NAV.map((item) => item.href));
  });

  it('shows a buyer and a finance user only what they hold', () => {
    for (const role of [ROLES.BUYER, ROLES.FINANCE]) {
      const hrefs = navFor(permissionsFor(role), planeOf(role)).map((item) => item.href);

      expect(hrefs).toContain('/workspace');
      expect(hrefs).toContain('/workspace/suppliers');
      // Staff management, settings and the audit trail are the administrator's.
      expect(hrefs).not.toContain('/workspace/users');
      expect(hrefs).not.toContain('/workspace/settings');
      expect(hrefs).not.toContain('/workspace/audit');
    }
  });

  it('gives buyer and finance the tenant-wide monitoring screens too, not just their own function', () => {
    // config/permissions.js deliberately does not silo these: a buyer holds
    // invoice:read/payment:read and finance holds rfq:read/po:read (both are
    // in TENANT_READ_ONLY, shared by every tenant role). A buyer watching
    // spend and a finance user watching what sourcing has committed to are
    // both legitimate — this is not an oversight to "fix" by narrowing later.
    for (const role of [ROLES.BUYER, ROLES.FINANCE]) {
      const hrefs = navFor(permissionsFor(role), planeOf(role)).map((item) => item.href);
      expect(hrefs).toContain('/workspace/rfqs');
      expect(hrefs).toContain('/workspace/purchase-orders');
      expect(hrefs).toContain('/workspace/invoices');
      expect(hrefs).toContain('/workspace/payments');
    }
  });

  it('shows a supplier and a platform operator nothing at all, on their real plane', () => {
    expect(navFor(permissionsFor(ROLES.VENDOR), planeOf(ROLES.VENDOR))).toHaveLength(0);
    expect(navFor(permissionsFor(ROLES.SUPER_ADMIN), planeOf(ROLES.SUPER_ADMIN))).toHaveLength(0);
  });

  it('shows nothing when plane is missing or wrong, even for a genuine tenant role’s permissions', () => {
    // The permission string alone is not enough to trust — rfq:read/po:read/
    // invoice:read/payment:read are held by the supplier role too (for their
    // own single-vendor view), so a caller that forgets to pass the
    // server-verified plane must fail closed rather than fail open.
    const adminPermissions = permissionsFor(ROLES.CLIENT_ADMIN);
    expect(navFor(adminPermissions)).toHaveLength(0);
    expect(navFor(adminPermissions, undefined)).toHaveLength(0);
    expect(navFor(adminPermissions, 'supplier')).toHaveLength(0);
    expect(navFor(adminPermissions, 'platform')).toHaveLength(0);
  });

  it('highlights the overview only on the overview', () => {
    const overview = WORKSPACE_NAV.find((item) => item.href === '/workspace');
    const suppliers = WORKSPACE_NAV.find((item) => item.href === '/workspace/suppliers');

    expect(isActive(overview, '/workspace')).toBe(true);
    expect(isActive(overview, '/workspace/suppliers')).toBe(false);
    expect(isActive(suppliers, '/workspace/suppliers')).toBe(true);
  });
});
