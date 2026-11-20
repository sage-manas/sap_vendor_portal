import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import {
  PRE_SUBMISSION_STATUSES, AWAITING_APPROVAL_STATUSES, isOnboarding, isAwaitingApproval,
  isRegistrationComplete, modulesFor, ONBOARDING_MODULE,
} from './onboarding';

// Same reasoning as workspaceNav.test.js: this list mirrors one the backend
// enforces, and a drift between them means the portal either hides a tab the
// server allows or shows one it refuses. So the test reaches across to the real
// registry rather than a copy of it.
const require = createRequire(import.meta.url);
const {
  VENDOR_PRE_SUBMISSION, VENDOR_AWAITING_DECISION, VENDOR_TRANSACTING, VENDOR_STATUSES,
} = require('../../backend/config/statuses');

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
    expect([...AWAITING_APPROVAL_STATUSES].sort()).toEqual([...VENDOR_AWAITING_DECISION].sort());
  });

  // The backend opens the modules for VENDOR_TRANSACTING and nothing else, so
  // every other status has to hide them here — or the portal shows a tab whose
  // every request answers 403.
  it('hides the modules for every status the backend refuses', () => {
    for (const status of VENDOR_STATUSES.filter((s) => !VENDOR_TRANSACTING.includes(s))) {
      const shown = modulesFor(MODULES, { isSupplier: true, profile: { status } });
      expect([status, shown.map((item) => item.id)]).toEqual([status, [ONBOARDING_MODULE]]);
    }
  });

  it('names only statuses the backend knows', () => {
    for (const status of [...PRE_SUBMISSION_STATUSES, ...AWAITING_APPROVAL_STATUSES]) {
      expect(VENDOR_STATUSES).toContain(status);
    }
  });

  it.each(VENDOR_PRE_SUBMISSION)('treats %s as still onboarding', (status) => {
    expect(isOnboarding({ status })).toBe(true);
  });

  it.each(VENDOR_AWAITING_DECISION)('treats %s as submitted but awaiting approval, not onboarding', (status) => {
    expect(isOnboarding({ status })).toBe(false);
    expect(isAwaitingApproval({ status })).toBe(true);
  });

  it('treats Approved as neither', () => {
    expect(isOnboarding({ status: 'Approved' })).toBe(false);
    expect(isAwaitingApproval({ status: 'Approved' })).toBe(false);
  });

  it('does not blank the navigation before the profile has loaded', () => {
    expect(isOnboarding(undefined)).toBe(false);
    expect(isOnboarding({})).toBe(false);
  });

  it('leaves a mid-onboarding supplier the registration tab and nothing else', () => {
    const shown = modulesFor(MODULES, { isSupplier: true, profile: { status: 'Draft' } });
    expect(shown.map((item) => item.id)).toEqual([ONBOARDING_MODULE]);
  });

  it('keeps a submitted supplier on the registration tab until their buyer approves', () => {
    const shown = modulesFor(MODULES, { isSupplier: true, profile: { status: 'Pending Approval' } });
    expect(shown.map((item) => item.id)).toEqual([ONBOARDING_MODULE]);
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

  it('keeps the company profile (registration) for an approved supplier, alongside everything else', () => {
    const shown = modulesFor(MODULES, { isSupplier: true, profile: { status: 'Approved' } });
    expect(shown).toEqual(MODULES);
    expect(shown.map((item) => item.id)).toContain(ONBOARDING_MODULE);
  });

  it('never hides the registration tab from tenant staff, approved or not', () => {
    const shown = modulesFor(MODULES, { isSupplier: false, profile: { status: 'Approved' } });
    expect(shown).toEqual(MODULES);
  });
});
