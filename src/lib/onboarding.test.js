import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { PRE_SUBMISSION_STATUSES, isOnboarding, isRegistrationComplete, modulesFor, ONBOARDING_MODULE } from './onboarding';

// Same reasoning as workspaceNav.test.js: this list mirrors one the backend
// enforces, and a drift between them means the portal either hides a tab the
// server allows or shows one it refuses. So the test reaches across to the real
// registry rather than a copy of it.
const require = createRequire(import.meta.url);
const { VENDOR_PRE_SUBMISSION, VENDOR_STATUSES } = require('../../backend/config/statuses');

const MODULES = [
  { id: 'registration' },
  { id: 'rfqs' },
  { id: 'pos' },
  { id: 'invoices' },
  { id: 'payments' },
];

describe('the supplier onboarding gate', () => {
  it('mirrors the statuses the backend closes the modules for', () => {
    expect([...PRE_SUBMISSION_STATUSES].sort()).toEqual([...VENDOR_PRE_SUBMISSION].sort());
  });

  it('names only statuses the backend knows', () => {
    for (const status of PRE_SUBMISSION_STATUSES) {
      expect(VENDOR_STATUSES).toContain(status);
    }
  });

  it.each(VENDOR_PRE_SUBMISSION)('treats %s as still onboarding', (status) => {
    expect(isOnboarding({ status })).toBe(true);
  });

  it.each(['Pending Approval', 'Under Review', 'Approved'])('treats %s as done', (status) => {
    expect(isOnboarding({ status })).toBe(false);
  });

  it('does not blank the navigation before the profile has loaded', () => {
    expect(isOnboarding(undefined)).toBe(false);
    expect(isOnboarding({})).toBe(false);
  });

  it('leaves a mid-onboarding supplier the registration tab and nothing else', () => {
    const shown = modulesFor(MODULES, { isSupplier: true, profile: { status: 'Draft' } });
    expect(shown.map((item) => item.id)).toEqual([ONBOARDING_MODULE]);
  });

  it('gives a submitted supplier every module back', () => {
    const shown = modulesFor(MODULES, { isSupplier: true, profile: { status: 'Under Review' } });
    expect(shown).toEqual(MODULES);
  });

  it('never gates tenant staff, who have no registration to finish', () => {
    const shown = modulesFor(MODULES, { isSupplier: false, profile: { status: 'Draft' } });
    expect(shown).toEqual(MODULES);
  });

  it('treats Approved, and only Approved, as registration complete', () => {
    expect(isRegistrationComplete({ status: 'Approved' })).toBe(true);
    for (const status of [...VENDOR_PRE_SUBMISSION, 'Pending Approval', 'Under Review']) {
      expect(isRegistrationComplete({ status })).toBe(false);
    }
    expect(isRegistrationComplete(undefined)).toBe(false);
  });

  it('drops the registration tab for an approved supplier, keeping everything else', () => {
    const shown = modulesFor(MODULES, { isSupplier: true, profile: { status: 'Approved' } });
    expect(shown.map((item) => item.id)).toEqual(MODULES.filter((m) => m.id !== ONBOARDING_MODULE).map((m) => m.id));
  });

  it('never hides the registration tab from tenant staff, approved or not', () => {
    const shown = modulesFor(MODULES, { isSupplier: false, profile: { status: 'Approved' } });
    expect(shown).toEqual(MODULES);
  });
});
