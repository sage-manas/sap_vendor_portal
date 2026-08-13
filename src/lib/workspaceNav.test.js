import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { WORKSPACE_NAV, navFor, isActive } from './workspaceNav';

// Same reasoning as platformNav.test.js: the registry names permissions the
// backend defines, and a typo'd permission hides a tab from everyone silently.
// So the test reaches across to the real map rather than a copy of it.
const require = createRequire(import.meta.url);
const { ALL_PERMISSIONS, permissionsFor } = require('../../backend/config/permissions');
const { ROLES } = require('../../backend/config/roles');

describe('the workspace nav registry', () => {
  it('names only permissions the backend actually grants', () => {
    for (const item of WORKSPACE_NAV) {
      expect(ALL_PERMISSIONS, `${item.href} declares an unknown permission`).toContain(item.permission);
    }
  });

  it('shows a client_admin the whole back office', () => {
    const admin = navFor(permissionsFor(ROLES.CLIENT_ADMIN)).map((item) => item.href);
    expect(admin).toEqual(WORKSPACE_NAV.map((item) => item.href));
  });

  it('shows a buyer and a finance user only what they hold', () => {
    for (const role of [ROLES.BUYER, ROLES.FINANCE]) {
      const hrefs = navFor(permissionsFor(role)).map((item) => item.href);

      expect(hrefs).toContain('/workspace');
      expect(hrefs).toContain('/workspace/suppliers');
      // Staff management, settings and the audit trail are the administrator's.
      expect(hrefs).not.toContain('/workspace/users');
      expect(hrefs).not.toContain('/workspace/settings');
      expect(hrefs).not.toContain('/workspace/audit');
    }
  });

  it('shows a supplier and a platform operator nothing at all', () => {
    expect(navFor(permissionsFor(ROLES.VENDOR))).toHaveLength(0);
    expect(navFor(permissionsFor(ROLES.SUPER_ADMIN))).toHaveLength(0);
  });

  it('highlights the overview only on the overview', () => {
    const overview = WORKSPACE_NAV.find((item) => item.href === '/workspace');
    const suppliers = WORKSPACE_NAV.find((item) => item.href === '/workspace/suppliers');

    expect(isActive(overview, '/workspace')).toBe(true);
    expect(isActive(overview, '/workspace/suppliers')).toBe(false);
    expect(isActive(suppliers, '/workspace/suppliers')).toBe(true);
  });
});
