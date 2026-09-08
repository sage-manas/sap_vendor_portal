import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import { SAP_SYNC_STATES, describeSyncState } from './syncState';

const require = createRequire(import.meta.url);
const { SAP_SYNC_STATES: BACKEND_STATES } = require('../../backend/config/statuses');

describe('SAP_SYNC_STATES', () => {
  it('names exactly the states the backend registry declares', () => {
    expect(SAP_SYNC_STATES.sort()).toEqual([...BACKEND_STATES].sort());
  });
});

describe('describeSyncState', () => {
  it('only `synced` may show the real SAP document number — invariant I5', () => {
    for (const state of SAP_SYNC_STATES) {
      const { showNumber } = describeSyncState(state);
      expect(showNumber).toBe(state === 'synced');
    }
  });

  it('failed and orphaned read the same to a supplier — neither is their problem to diagnose', () => {
    expect(describeSyncState('failed')).toEqual(describeSyncState('orphaned'));
  });

  it('an unknown value falls back to the safe, non-alarming default rather than throwing', () => {
    expect(() => describeSyncState('something-new')).not.toThrow();
    expect(describeSyncState('something-new').showNumber).toBe(false);
  });
});
