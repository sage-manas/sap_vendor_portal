// jobs/fingerprint.js — Phase 4.2 of docs/04-sap-runtime-engineering-plan.md.
const { fingerprint, normalize } = require('../jobs/fingerprint');

describe('fingerprint', () => {
  it('is stable across key reordering', () => {
    const a = { orders: [{ poNumber: '1', currency: 'INR' }], count: 1 };
    const b = { count: 1, orders: [{ currency: 'INR', poNumber: '1' }] };

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('is stable across a volatile field changing (timestamp, syncedAt, requestId, correlationId, source)', () => {
    const a = { orders: [{ poNumber: '1' }], timestamp: '2026-01-01T00:00:00Z', requestId: 'req-1', correlationId: 'corr-1', source: 'mock' };
    const b = { orders: [{ poNumber: '1' }], timestamp: '2026-06-01T00:00:00Z', requestId: 'req-2', correlationId: 'corr-2', source: 'mock' };

    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('changes when the actual data changes', () => {
    const a = { orders: [{ poNumber: '1', netAmount: 100 }] };
    const b = { orders: [{ poNumber: '1', netAmount: 200 }] };

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('changes when a row is added or removed', () => {
    const a = { orders: [{ poNumber: '1' }] };
    const b = { orders: [{ poNumber: '1' }, { poNumber: '2' }] };

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('does not ignore array order — position is meaningful for a list of rows', () => {
    const a = { orders: [{ poNumber: '1' }, { poNumber: '2' }] };
    const b = { orders: [{ poNumber: '2' }, { poNumber: '1' }] };

    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('accepts feed-specific extra volatile keys', () => {
    const a = { orders: [{ poNumber: '1' }], pageGeneratedAt: '2026-01-01' };
    const b = { orders: [{ poNumber: '1' }], pageGeneratedAt: '2026-06-01' };

    expect(fingerprint(a)).not.toBe(fingerprint(b)); // not volatile by default
    expect(fingerprint(a, { extraVolatileKeys: ['pageGeneratedAt'] }))
      .toBe(fingerprint(b, { extraVolatileKeys: ['pageGeneratedAt'] }));
  });

  it('strips volatile keys at any depth, not just the top level', () => {
    const a = { orders: [{ poNumber: '1', meta: { timestamp: 't1' } }] };
    const b = { orders: [{ poNumber: '1', meta: { timestamp: 't2' } }] };

    expect(fingerprint(a)).toBe(fingerprint(b));
  });
});

describe('normalize', () => {
  it('sorts object keys recursively', () => {
    const input = { b: 1, a: { d: 1, c: 2 } };
    expect(Object.keys(normalize(input, new Set()))).toEqual(['a', 'b']);
    expect(Object.keys(normalize(input, new Set()).a)).toEqual(['c', 'd']);
  });

  it('serialises a Date the same way regardless of instance', () => {
    const d1 = new Date('2026-01-01T00:00:00.000Z');
    const d2 = new Date('2026-01-01T00:00:00.000Z');
    expect(normalize(d1, new Set())).toBe(normalize(d2, new Set()));
  });
});
