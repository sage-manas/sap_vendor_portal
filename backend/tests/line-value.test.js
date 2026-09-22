const { lineNetValue } = require('../utils/lineValue');

// Issue #108. SAP's NETPR is the price for PEINH units, not for one. The
// portal sent PEINH to SAP and then computed `quantity * unitPrice` anyway, in
// two places, so any line with a price unit other than 1 was recorded — and
// previewed to the operator — overstated by exactly that factor.
//
// Pure-function tests: this is the arithmetic itself, and it is worth pinning
// away from the controller because the controller's own test suite pinned
// `priceUnit: 1` in every case, which is precisely what hid the bug.

describe('lineNetValue', () => {
  it('divides by the price unit', () => {
    // The case from the issue: 200 units at 5,000 per 100 is 10,000, not
    // 1,000,000.
    expect(lineNetValue({ quantity: 200, unitPrice: 5000, priceUnit: 100 })).toBe(10000);
  });

  it('is unchanged for the common price unit of 1', () => {
    expect(lineNetValue({ quantity: 5, unitPrice: 10000, priceUnit: 1 })).toBe(50000);
  });

  it('treats a missing price unit as 1 rather than dividing by nothing', () => {
    expect(lineNetValue({ quantity: 5, unitPrice: 10000 })).toBe(50000);
    expect(lineNetValue({ quantity: 5, unitPrice: 10000, priceUnit: null })).toBe(50000);
  });

  it('never divides by zero', () => {
    // Not a legitimate PEINH, and the validator refuses it on the way in — but
    // Infinity written into a money column is worse than reading it as "not
    // stated".
    expect(lineNetValue({ quantity: 5, unitPrice: 10000, priceUnit: 0 })).toBe(50000);
  });

  it('accepts Decimal-typed columns the way the rest of the money code does', () => {
    // Prisma hands back decimal.js instances, whose valueOf() is a string —
    // the trap utils/money.js exists for.
    const decimalish = (v) => ({ valueOf: () => String(v), toString: () => String(v) });
    expect(lineNetValue({
      quantity: decimalish('200.000'),
      unitPrice: decimalish('5000.00'),
      priceUnit: 100,
    })).toBe(10000);
  });

  it('rounds to two places, dividing before rounding', () => {
    // 7 / 3 * 10 = 23.333… — rounding the division first would lose more.
    expect(lineNetValue({ quantity: 7, unitPrice: 10, priceUnit: 3 })).toBe(23.33);
  });

  it('handles a fractional quantity, since MENGE carries three decimals', () => {
    expect(lineNetValue({ quantity: 0.125, unitPrice: 800, priceUnit: 1 })).toBe(100);
  });

  it('is zero when either side is missing, not NaN', () => {
    expect(lineNetValue({})).toBe(0);
    expect(lineNetValue({ quantity: 5 })).toBe(0);
    expect(lineNetValue({ unitPrice: 5 })).toBe(0);
  });
});
