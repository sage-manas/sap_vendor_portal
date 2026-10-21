import { describe, it, expect } from 'vitest';
import { formatMoney, formatAmount, formatMoneyCompact } from './money';

// Issue #285. The paise are the point: four staff pages rounded to whole
// rupees, so the invoice finance was reconciling read ₹1,235 on one screen
// and ₹1,234.56 on the next.

describe('formatMoney', () => {
  it('keeps the paise', () => {
    expect(formatMoney(1234.56)).toBe('₹1,234.56');
  });

  it('shows a trailing zero rather than dropping it', () => {
    expect(formatMoney(1234.5)).toBe('₹1,234.50');
    expect(formatMoney(1234)).toBe('₹1,234.00');
  });

  it('groups in lakhs, the way en-IN does', () => {
    expect(formatMoney(177000)).toBe('₹1,77,000.00');
    expect(formatMoney(12345678.9)).toBe('₹1,23,45,678.90');
  });

  it('takes Decimal strings, the shape the API sends', () => {
    expect(formatMoney('1234.56')).toBe('₹1,234.56');
  });

  it('reads a missing amount as zero', () => {
    expect(formatMoney(null)).toBe('₹0.00');
    expect(formatMoney(undefined)).toBe('₹0.00');
    expect(formatMoney('')).toBe('₹0.00');
    expect(formatMoney('not a number')).toBe('₹0.00');
  });

  it('honours another currency', () => {
    expect(formatMoney(1234.56, 'USD')).toBe('$1,234.56');
  });
});

describe('formatAmount', () => {
  it('is the same number without the symbol', () => {
    expect(formatAmount(1234.56)).toBe('1,234.56');
    expect(formatAmount(177000)).toBe('1,77,000.00');
    expect(formatAmount(null)).toBe('0.00');
  });
});

describe('formatMoneyCompact', () => {
  it('shortens to Indian units for tiles and axis ticks', () => {
    expect(formatMoneyCompact(950)).toBe('₹950');
    expect(formatMoneyCompact(45000)).toBe('₹45K');
    expect(formatMoneyCompact(120000)).toBe('₹1.2L');
    expect(formatMoneyCompact(34000000)).toBe('₹3.4Cr');
    expect(formatMoneyCompact(-45000)).toBe('−₹45K');
  });
});
