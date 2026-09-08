import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { SAP_FIELD_KEYS } from './sapFields';

// SAP_FIELD_KEYS is the list of field names forms look up
// (fields.MATNR.max, etc.) — checked against the real backend registry so a
// renamed or removed field fails here instead of quietly breaking a form's
// maxLength. Same pattern as platformNav.test.js/workspaceNav.test.js.
const require = createRequire(import.meta.url);
const { SAP_FIELDS } = require('../../backend/sap/mappings/fields');

describe('SAP_FIELD_KEYS', () => {
  it('names exactly the fields the backend registry declares', () => {
    expect(SAP_FIELD_KEYS.sort()).toEqual(Object.keys(SAP_FIELDS).sort());
  });

  it('every field the backend declares has a positive max length', () => {
    for (const key of SAP_FIELD_KEYS) {
      expect(SAP_FIELDS[key].max).toBeGreaterThan(0);
    }
  });
});
