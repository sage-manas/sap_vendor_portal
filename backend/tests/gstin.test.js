const {
  gstinCheckCharacter,
  hasValidCheckCharacter,
  panOfGstin,
} = require('../utils/gstin');
const { verifyGstinPan } = require('../services/verification.service');

// The GSTIN's own arithmetic (utils/gstin.js): the offline check that runs on
// every write, before any paid verification provider is involved.

// A GSTIN with a correct check character, and the same GSTIN with every other
// possible last character.
const GOOD = '27AAPFU0939F1ZV';
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describe('the GSTIN check character', () => {
  it('accepts a GSTIN whose last character is its check character', () => {
    expect(gstinCheckCharacter(GOOD.slice(0, 14))).toBe('V');
    expect(hasValidCheckCharacter(GOOD)).toBe(true);
  });

  it('accepts it in lower case too, as the validators do', () => {
    expect(hasValidCheckCharacter(GOOD.toLowerCase())).toBe(true);
  });

  it('refuses every other last character', () => {
    const others = [...CHARSET].filter((c) => c !== 'V').map((c) => `${GOOD.slice(0, 14)}${c}`);
    expect(others.filter(hasValidCheckCharacter)).toEqual([]);
  });

  it('catches two neighbouring characters typed the wrong way round', () => {
    // 0939 → 9039: the slip a check character exists to catch.
    expect(hasValidCheckCharacter('27AAPFU9039F1ZV')).toBe(false);
  });

  it('refuses something that is not GSTIN-shaped at all', () => {
    for (const value of ['', null, undefined, 'not-a-gstin', GOOD.slice(0, 14)]) {
      expect(hasValidCheckCharacter(value)).toBe(false);
    }
  });

  it('reads the PAN out of characters 3–12', () => {
    expect(panOfGstin(GOOD)).toBe('AAPFU0939F');
  });
});

describe('the mock GSTIN/PAN verification', () => {
  it('passes a GSTIN with its own PAN', async () => {
    expect(await verifyGstinPan(GOOD, 'AAPFU0939F')).toMatchObject({ gstinValid: true, panValid: true });
  });

  it('fails a GSTIN whose check character is wrong, even if the PAN matches it', async () => {
    // A row written before the validators refused it would otherwise pass.
    expect(await verifyGstinPan('27AAPFU0939F1Z1', 'AAPFU0939F')).toMatchObject({ gstinValid: false, panValid: false });
  });

  it('fails a PAN that is not the one inside the GSTIN', async () => {
    expect(await verifyGstinPan(GOOD, 'AAPFU0939G')).toMatchObject({ gstinValid: true, panValid: false });
  });
});
