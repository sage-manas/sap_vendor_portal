import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// Finding 4.4. The frontend deliberately holds no state list of its own — it
// reads GET /meta/indian-states. What this file checks is the thing that makes
// that worth doing: that the backend registry still agrees, name for name,
// with the list the supplier registration form has always offered.
//
// This matters because services/gst.service.js's isIntraState compares the
// buyer tenant's state to the supplier's as trimmed, lower-cased strings. A
// supplier who registered picking 'Jammu & Kashmir' from the form and a tenant
// configured with a backend registry that had drifted to 'Jammu and Kashmir'
// would have every invoice between them split as inter-state — IGST instead of
// CGST+SGST, on every line, with no error raised anywhere.
//
// Reaching into the backend module with createRequire is the pattern
// sapFields.test.js and platformNav.test.js already use for the same purpose:
// a renamed entry fails here rather than quietly breaking something at
// runtime.
//
// The duplicate list in RegistrationView.jsx is tracked by issue #221, which
// replaces it with this endpoint. Until then this test is what keeps the two
// honest, so it is pinned to that issue deliberately: when #221 lands, the
// registration form reads the registry and the first case below becomes
// redundant rather than wrong.
const require = createRequire(import.meta.url);
const { INDIAN_STATES, canonicalStateName, gstinMatchesState } = require('../../backend/config/indianStates');

// The list the supplier registration form offers today, read out of the
// component rather than restated, so this cannot pass against a stale copy of
// what that file used to say.
const registrationFormStates = () => {
  const { readFileSync } = require('node:fs');
  const source = readFileSync(require.resolve('../features/profile/components/RegistrationView.jsx'), 'utf8');
  const block = source.match(/const INDIAN_STATES = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('Could not find INDIAN_STATES in RegistrationView.jsx — has it moved? See issue #221.');
  return [...block[1].matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
};

describe('the backend state registry and the supplier registration form agree', () => {
  it('offers exactly the same state names', () => {
    expect(INDIAN_STATES.map((entry) => entry.name).sort())
      .toEqual(registrationFormStates().sort());
  });
});

describe('the registry is internally consistent', () => {
  it('gives every state a two-digit GST state code', () => {
    for (const entry of INDIAN_STATES) {
      expect([entry.name, entry.gstCode]).toEqual([entry.name, expect.stringMatching(/^\d{2}$/)]);
    }
  });

  it('names every state exactly once', () => {
    const names = INDIAN_STATES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('accepts its own names back, in any casing', () => {
    for (const { name } of INDIAN_STATES) {
      expect(canonicalStateName(name)).toBe(name);
      expect(canonicalStateName(name.toUpperCase())).toBe(name);
      expect(canonicalStateName(`  ${name.toLowerCase()}  `)).toBe(name);
    }
  });

  it('rejects a state code where a name is expected', () => {
    // 'MH' is the list's own `code`, and accepting it would store a value no
    // supplier's state can ever equal.
    for (const { code } of INDIAN_STATES) {
      expect(canonicalStateName(code)).toBeNull();
    }
  });

  it('matches each state against a GSTIN carrying its own code', () => {
    for (const { name, gstCode } of INDIAN_STATES) {
      expect([name, gstinMatchesState(`${gstCode}AABCU9603R1ZM`, name)]).toEqual([name, true]);
    }
  });

  it('treats a missing GSTIN or state as no contradiction', () => {
    expect(gstinMatchesState(null, 'Maharashtra')).toBe(true);
    expect(gstinMatchesState('27AABCU9603R1ZM', null)).toBe(true);
    expect(gstinMatchesState(null, null)).toBe(true);
  });

  it('treats a GSTIN prefix the registry does not know as no contradiction', () => {
    // 97 and 99 are the non-resident and OIDAR registration ranges; a new
    // union territory would be another. The registry cannot speak about them,
    // and silence is not a contradiction — the GSTIN regex has already
    // vouched for the shape.
    expect(gstinMatchesState('97AABCU9603R1ZM', 'Maharashtra')).toBe(true);
  });
});
