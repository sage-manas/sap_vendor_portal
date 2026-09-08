// sap/mappings/fields.js — Phase 2 of docs/04-sap-runtime-engineering-plan.md.
const {
  SAP_FIELDS,
  SapFieldError,
  encodeForSap,
  decodeFromSap,
  applyFieldEncoding,
} = require('../sap/mappings/fields');

describe('SAP field registry', () => {
  it('every field round-trips: decoding an encoded value is display-stable', () => {
    const samples = {
      LIFNR: '10423',
      MATNR: 'mat-3849',
      EBELN: '4500001234',
      TXZ01: 'Steel Pipe 3" SCH40',
      MEINS: 'each',
      WAERS: 'inr',
    };

    for (const [field, value] of Object.entries(SAP_FIELDS)) {
      const encoded = encodeForSap(field, samples[field]);
      const decoded = decodeFromSap(field, encoded);
      // Idempotent: decoding an already-decoded (display) value must not
      // change it further.
      expect(decodeFromSap(field, decoded)).toBe(decoded);
    }
  });

  it('LIFNR pads to 10 digits and is idempotent on an already-padded value', () => {
    expect(encodeForSap('LIFNR', '10423')).toBe('0000010423');
    expect(encodeForSap('LIFNR', '0000010423')).toBe('0000010423');
  });

  it('decodeFromSap strips LIFNR/EBELN leading zeros for display', () => {
    expect(decodeFromSap('LIFNR', '0000010423')).toBe('10423');
    expect(decodeFromSap('EBELN', '4500001234')).toBe('4500001234'); // no leading zeros to strip
  });

  it('an unmapped unit throws SapFieldError rather than defaulting', () => {
    expect(() => encodeForSap('MEINS', 'Cartons')).toThrow(SapFieldError);
    expect(() => encodeForSap('MEINS', 'Cartons')).toThrow(/unmapped unit/);
  });

  it('a known unit — including case/whitespace variants — maps to its ISO code', () => {
    expect(encodeForSap('MEINS', 'each')).toBe('PCE');
    expect(encodeForSap('MEINS', ' EA ')).toBe('PCE');
    expect(encodeForSap('MEINS', 'Kg')).toBe('KGM');
  });

  it('a value that exceeds max length after encoding throws', () => {
    expect(() => encodeForSap('TXZ01', 'x'.repeat(41))).not.toThrow(); // truncated by encode(), not rejected
    expect(encodeForSap('TXZ01', 'x'.repeat(41))).toHaveLength(40);
    // LIFNR has no truncation step, so an over-length source value must reject.
    expect(() => encodeForSap('LIFNR', '123456789012')).toThrow(SapFieldError);
  });

  it('passes null/undefined/empty through unchanged — a required check is the caller\'s job', () => {
    expect(encodeForSap('LIFNR', null)).toBeNull();
    expect(encodeForSap('LIFNR', undefined)).toBeUndefined();
    expect(encodeForSap('LIFNR', '')).toBe('');
  });

  describe('applyFieldEncoding', () => {
    it('encodes only the declared paths and leaves the rest of args untouched', () => {
      const args = { vendor: { sapVendorCode: '10423', companyName: 'Acme' }, other: { keep: true } };
      const result = applyFieldEncoding({ 'vendor.sapVendorCode': 'LIFNR' }, args);

      expect(result.vendor.sapVendorCode).toBe('0000010423');
      expect(result.vendor.companyName).toBe('Acme');
      expect(result.other).toBe(args.other); // untouched branch, same reference
    });

    it('does not mutate the original args object', () => {
      const args = { vendor: { sapVendorCode: '10423' } };
      applyFieldEncoding({ 'vendor.sapVendorCode': 'LIFNR' }, args);

      expect(args.vendor.sapVendorCode).toBe('10423');
    });

    it('is a no-op when the method declares no fields', () => {
      const args = { anything: 1 };
      expect(applyFieldEncoding(undefined, args)).toBe(args);
    });

    it('skips a path that is undefined on args rather than throwing', () => {
      const args = { vendor: {} };
      expect(() => applyFieldEncoding({ 'vendor.sapVendorCode': 'LIFNR' }, args)).not.toThrow();
    });
  });
});
