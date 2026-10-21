import { describe, it, expect } from 'vitest';
import { paymentInvoiceLabel, paymentInvoiceRefs } from './paymentInvoiceLabel';

// Issue #282. The truncation rule is the Overview's own `listIds` — first
// three, then `+n` — so a remittance covering a whole F110 run stays one line
// instead of pushing a table column open.
describe('paymentInvoiceLabel', () => {
  it('renders the backend-derived invoiceRefs', () => {
    expect(paymentInvoiceLabel({ invoiceRefs: ['INV-1', 'INV-2'] })).toBe('INV-1, INV-2');
  });

  it('truncates past three, naming how many more', () => {
    expect(paymentInvoiceLabel({ invoiceRefs: ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5'] }))
      .toBe('INV-1, INV-2, INV-3 +2');
  });

  it('derives from items when invoiceRefs is absent', () => {
    const payment = {
      items: [
        { invoiceNumber: 'V/001', invoiceId: 'INV-1' },
        // No number from SAP — the internal id is the honest reference.
        { invoiceId: 'INV-2' },
      ],
    };
    expect(paymentInvoiceRefs(payment)).toEqual(['V/001', 'INV-2']);
    expect(paymentInvoiceLabel(payment)).toBe('V/001, INV-2');
  });

  it("returns '' when nothing is known, rather than inventing a placeholder", () => {
    // Each caller decides how an unknown reads — '—' in a table cell, or
    // omitting the line entirely on the Overview.
    expect(paymentInvoiceLabel({ id: 'PMT-1' })).toBe('');
    expect(paymentInvoiceLabel({ items: [] })).toBe('');
    expect(paymentInvoiceLabel({ invoiceRefs: [] })).toBe('');
    expect(paymentInvoiceLabel(null)).toBe('');
  });
});
