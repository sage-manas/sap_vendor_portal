import { describe, expect, it } from 'vitest';

import { PROFILE_WRITABLE_FIELDS, pickProfileFields } from './profileFields';
import validationSource from './validation.js?raw';

// backend/tests/profile-fields-contract.test.js holds this list and the API
// schema to each other. That kept them in step but not complete: both left out
// gstType, which Step 2 requires, so the form dropped it before every save and
// the field read as required again on each reload. This holds the list to what
// the form actually asks for. The required fields are read out of
// validation.js's own switch, so a field added there is checked here unprompted.
const requiredFields = [...validationSource.matchAll(/case '([^']+)':/g)].map((match) => match[1]);

describe('the profile form can save every field it requires', () => {
  it('reads the required fields from validation.js', () => {
    expect(requiredFields.length).toBeGreaterThan(20);
    expect(requiredFields).toContain('gstType');
  });

  it('lists every required field as writable', () => {
    expect(requiredFields.filter((field) => !PROFILE_WRITABLE_FIELDS.includes(field))).toEqual([]);
  });

  it('keeps the GST registration type when narrowing the profile for a save', () => {
    expect(pickProfileFields({ gstType: '01', status: 'Approved' })).toEqual({ gstType: '01' });
  });
});
