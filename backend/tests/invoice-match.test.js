// Issue #64: matching on purchase order + gross amount alone can never
// resolve a periodic invoicing plan — a monthly plan bills the same PO and
// amount every period, so from the second invoice onward there are always
// at least two SAP documents that fit. A date-proximity tiebreak resolves
// most of those; when it can't, matchInvoiceDocument must say so distinctly
// from "not found yet" rather than leave the caller to retry forever.
const { matchInvoiceDocument, AmbiguousInvoiceMatchError, DATE_TOLERANCE_DAYS } = require('../sap/mappings/invoice-match');

const doc = (miroDoc, { poNumber = '4500012345', grossAmount = 50000, docDate } = {}) => ({
  miroDoc, poNumber, grossAmount, docDate,
});

describe('matchInvoiceDocument', () => {
  it('returns the one document that fits PO + amount', () => {
    const invoice = { sapPoNumber: '4500012345', totalAmount: 50000 };
    const documents = [doc('5100000001'), doc('5100000002', { poNumber: '4500099999' })];

    expect(matchInvoiceDocument(invoice, documents)).toEqual(doc('5100000001'));
  });

  it('returns null when nothing fits — AP has not posted it yet', () => {
    const invoice = { sapPoNumber: '4500012345', totalAmount: 50000 };
    expect(matchInvoiceDocument(invoice, [doc('5100000001', { grossAmount: 99999 })])).toBeNull();
  });

  it('a periodic plan\'s two same-amount invoices each resolve to their own document by date', () => {
    const documents = [
      doc('5100000001', { docDate: '2026-01-05' }),
      doc('5100000002', { docDate: '2026-02-05' }),
    ];

    const januaryInvoice = { sapPoNumber: '4500012345', totalAmount: 50000, invoiceDate: '2026-01-03' };
    const februaryInvoice = { sapPoNumber: '4500012345', totalAmount: 50000, invoiceDate: '2026-02-04' };

    expect(matchInvoiceDocument(januaryInvoice, documents).miroDoc).toBe('5100000001');
    expect(matchInvoiceDocument(februaryInvoice, documents).miroDoc).toBe('5100000002');
  });

  it('accepts ordinary AP posting lag within the tolerance window', () => {
    const documents = [
      doc('5100000001', { docDate: '2026-01-05' }),
      doc('5100000002', { docDate: '2026-02-05' }),
    ];
    // Posted 3 days after the supplier's own invoice date — comfortably
    // inside DATE_TOLERANCE_DAYS, and 1 month away from the other candidate.
    const invoice = { sapPoNumber: '4500012345', totalAmount: 50000, invoiceDate: '2026-01-02' };

    expect(matchInvoiceDocument(invoice, documents).miroDoc).toBe('5100000001');
  });

  it('throws AmbiguousInvoiceMatchError, not null, when the date tiebreak also fails', () => {
    const documents = [
      doc('5100000001', { docDate: '2026-01-05' }),
      doc('5100000002', { docDate: '2026-01-06' }),
    ];
    // Exactly as close to both — the tiebreak cannot pick one.
    const invoice = { sapPoNumber: '4500012345', totalAmount: 50000, invoiceDate: '2026-01-05T12:00:00Z' };

    let caught;
    try {
      matchInvoiceDocument(invoice, documents);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AmbiguousInvoiceMatchError);
    expect(caught.candidates.map((d) => d.miroDoc).sort()).toEqual(['5100000001', '5100000002']);
  });

  it('throws ambiguous rather than guessing when the invoice carries no date at all', () => {
    const documents = [doc('5100000001'), doc('5100000002')];
    const invoice = { sapPoNumber: '4500012345', totalAmount: 50000 };

    expect(() => matchInvoiceDocument(invoice, documents)).toThrow(AmbiguousInvoiceMatchError);
  });

  it('throws ambiguous when both candidates sit outside the date tolerance window', () => {
    const documents = [
      doc('5100000001', { docDate: '2026-01-05' }),
      doc('5100000002', { docDate: '2026-02-05' }),
    ];
    // Nowhere near either — a third period's date, say, with no document of
    // its own yet visible.
    const invoice = { sapPoNumber: '4500012345', totalAmount: 50000, invoiceDate: '2026-06-15' };

    expect(() => matchInvoiceDocument(invoice, documents)).toThrow(AmbiguousInvoiceMatchError);
  });

  it('is documented as generous enough for ordinary posting lag but tighter than a month', () => {
    expect(DATE_TOLERANCE_DAYS).toBeGreaterThan(0);
    expect(DATE_TOLERANCE_DAYS).toBeLessThan(28);
  });
});
