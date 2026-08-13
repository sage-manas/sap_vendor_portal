import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { PLATFORM_NAV, navFor, isActive } from './platformNav';

// The nav registry names permissions that the backend defines. Two registries
// in two languages will drift eventually, and the drift is silent: a typo'd
// permission simply hides the tab from everyone. So the test reaches across and
// checks the strings against the real map rather than a copy of it.
const require = createRequire(import.meta.url);
const { ALL_PERMISSIONS, permissionsFor } = require('../../backend/config/permissions');
const { ROLES } = require('../../backend/config/roles');

describe('the platform nav registry', () => {
  it('names only permissions the backend actually grants', () => {
    for (const item of PLATFORM_NAV) {
      expect(ALL_PERMISSIONS, `${item.href} declares an unknown permission`).toContain(item.permission);
    }
  });

  it('shows a super admin everything and an sap_manager only what they hold', () => {
    const superAdmin = navFor(permissionsFor(ROLES.SUPER_ADMIN)).map((item) => item.href);
    const sapManager = navFor(permissionsFor(ROLES.SAP_MANAGER)).map((item) => item.href);

    expect(superAdmin).toEqual(PLATFORM_NAV.map((item) => item.href));

    // An sap_manager cannot make operators, so the tab is absent rather than
    // present-and-403.
    expect(sapManager).toContain('/platform/sap');
    expect(sapManager).not.toContain('/platform/operators');
  });

  it('shows a tenant role nothing at all', () => {
    expect(navFor(permissionsFor(ROLES.CLIENT_ADMIN))).toHaveLength(0);
    expect(navFor(permissionsFor(ROLES.VENDOR))).toHaveLength(0);
  });

  it('highlights the overview only on the overview', () => {
    const overview = PLATFORM_NAV.find((item) => item.href === '/platform');
    const sap = PLATFORM_NAV.find((item) => item.href === '/platform/sap');

    expect(isActive(overview, '/platform')).toBe(true);
    expect(isActive(overview, '/platform/sap')).toBe(false);
    // A tenant's SAP screen lives under /platform/tenants, so it must not light
    // up the SAP tab.
    expect(isActive(sap, '/platform/tenants/CLT-0001/sap')).toBe(false);
    expect(isActive(sap, '/platform/sap')).toBe(true);
  });
});
