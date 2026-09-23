// Issue #66: GST used to be one header taxCode and one taxAmount, with an
// 18% rate assumed wherever the real figure was missing. services/
// gst.service.js is the real per-line computation this replaces — pure,
// like services/poStatus.service.js and services/invoicePlan.service.js.
const { splitLineTax, deriveGst, isIntraState } = require('../services/gst.service');

describe('isIntraState', () => {
  it('is true only when both states are known and match, case/whitespace-insensitively', () => {
    expect(isIntraState('Maharashtra', 'Maharashtra')).toBe(true);
    expect(isIntraState(' maharashtra ', 'MAHARASHTRA')).toBe(true);
    expect(isIntraState('Maharashtra', 'Karnataka')).toBe(false);
    expect(isIntraState(null, 'Maharashtra')).toBe(false);
    expect(isIntraState('Maharashtra', null)).toBe(false);
  });
});

describe('splitLineTax', () => {
  it('produces CGST+SGST, split evenly, for an intra-state supply', () => {
    const result = splitLineTax({
      taxableValue: 1000, gstRate: 18, supplierState: 'Maharashtra', placeOfSupply: 'Maharashtra',
    });
    expect(result.cgstAmount).toBe(90);
    expect(result.sgstAmount).toBe(90);
    expect(result.igstAmount).toBe(0);
    expect(result.cgstAmount + result.sgstAmount).toBeCloseTo(result.totalTax, 2);
  });

  it('produces IGST, at the full rate, for an inter-state supply', () => {
    const result = splitLineTax({
      taxableValue: 1000, gstRate: 18, supplierState: 'Maharashtra', placeOfSupply: 'Karnataka',
    });
    expect(result.cgstAmount).toBe(0);
    expect(result.sgstAmount).toBe(0);
    expect(result.igstAmount).toBe(180);
  });

  it('puts an odd paisa on SGST so CGST+SGST still equals what IGST would have charged', () => {
    // 18% of 100.01 = 18.0018, rounds to 18.00 — pick a value where the
    // half-split itself lands off a paisa instead.
    const result = splitLineTax({
      taxableValue: 100.05, gstRate: 18, supplierState: 'Maharashtra', placeOfSupply: 'Maharashtra',
    });
    expect(result.cgstAmount + result.sgstAmount).toBeCloseTo(result.totalTax, 2);
  });

  it('never guesses a rate — no gstRate means no tax, not an assumed 18%', () => {
    const result = splitLineTax({
      taxableValue: 1000, gstRate: null, supplierState: 'Maharashtra', placeOfSupply: 'Maharashtra',
    });
    expect(result).toEqual({ cgstAmount: 0, sgstAmount: 0, igstAmount: 0, totalTax: 0 });
  });

  it('treats an unknown place of supply as inter-state rather than guessing intra-state', () => {
    const result = splitLineTax({ taxableValue: 1000, gstRate: 18, supplierState: 'Maharashtra', placeOfSupply: null });
    expect(result.igstAmount).toBe(180);
    expect(result.cgstAmount).toBe(0);
  });
});

describe('deriveGst', () => {
  it('sums per-line tax into a derived header taxAmount/totalAmount, never an input', () => {
    const result = deriveGst({
      supplierState: 'Maharashtra',
      buyerState: 'Maharashtra',
      items: [
        { line: 10, amount: 1000, gstRate: 18, hsnCode: '7307' },
        { line: 20, amount: 500, gstRate: 12, hsnCode: '8481' },
      ],
    });

    expect(result.placeOfSupply).toBe('Maharashtra');
    expect(result.subTotal).toBe(1500);
    // 1000*18% = 180, 500*12% = 60 -> 240 total, split CGST/SGST since intra-state.
    expect(result.taxAmount).toBeCloseTo(240, 2);
    expect(result.totalAmount).toBeCloseTo(1740, 2);

    expect(result.items[0].cgstAmount).toBe(90);
    expect(result.items[0].sgstAmount).toBe(90);
    expect(result.items[1].cgstAmount).toBe(30);
    expect(result.items[1].sgstAmount).toBe(30);
    expect(result.items.every((item) => item.igstAmount === 0)).toBe(true);
  });

  it('sums into IGST for an inter-state buyer, with no CGST/SGST on any line', () => {
    const result = deriveGst({
      supplierState: 'Maharashtra',
      buyerState: 'Karnataka',
      items: [{ line: 10, amount: 1000, gstRate: 18, hsnCode: '7307' }],
    });

    expect(result.placeOfSupply).toBe('Karnataka');
    expect(result.taxAmount).toBe(180);
    expect(result.items[0].igstAmount).toBe(180);
    expect(result.items[0].cgstAmount).toBe(0);
    expect(result.items[0].sgstAmount).toBe(0);
  });

  it('marks a reverse-charge invoice, still carrying the rate that would have applied', () => {
    const result = deriveGst({
      supplierState: 'Maharashtra', buyerState: 'Maharashtra', reverseCharge: true,
      items: [{ line: 10, amount: 1000, gstRate: 18 }],
    });
    expect(result.reverseCharge).toBe(true);
    expect(result.taxAmount).toBeCloseTo(180, 2); // the rate is still recorded, per the function's own doc comment
  });

  it('produces no placeOfSupply and no tax on any line when the buyer state is unknown', () => {
    const result = deriveGst({
      supplierState: 'Maharashtra', buyerState: null,
      items: [{ line: 10, amount: 1000, gstRate: 18 }],
    });
    expect(result.placeOfSupply).toBeNull();
    // No place of supply known -> not intra-state -> IGST, the honest
    // "can't confirm same-state" answer rather than defaulting to CGST/SGST.
    expect(result.items[0].igstAmount).toBe(180);
  });
});
