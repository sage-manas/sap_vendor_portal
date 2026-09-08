import { describe, expect, it } from 'vitest';
import {
  mergeSapDocuments, countByType, commonPurchasingOrg, documentTypeOf, DOCUMENT_TYPE,
} from './sapDocuments';

// Rows shaped exactly as the two drivers emit them, from the live sandbox
// responses (see backend/tests/sap-read-contracts.test.js for the raw payloads).
const me48 = (documentNumber, date, extra = {}) => ({
  documentNumber,
  documentType: documentTypeOf(documentNumber),
  date,
  currency: 'INR',
  purchasingOrg: 'SSDN',
  ...extra,
});
const me43 = (sapRfqNumber, date, extra = {}) => ({
  sapRfqNumber, date, currency: 'INR', purchasingOrg: 'SSDN', ...extra,
});

describe('classifying a purchasing document', () => {
  it('reads the number range, since SAP names no category', () => {
    expect(documentTypeOf('6000000054')).toBe(DOCUMENT_TYPE.QUOTATION);
    expect(documentTypeOf('4500022503')).toBe(DOCUMENT_TYPE.PURCHASE_ORDER);
  });

  it('does not crash on a document with no number', () => {
    expect(documentTypeOf(null)).toBe(DOCUMENT_TYPE.PURCHASE_ORDER);
  });
});

describe('merging the ME43 and ME48 reads', () => {
  it('shows a quotation once when both reads report it', () => {
    // The overlap that makes this function necessary: ME48 returns the whole
    // EKKO set, so a 6xxxxxxx document comes back from both endpoints.
    const merged = mergeSapDocuments({
      quotationDocuments: [me48('6000000054', '20260108'), me48('4500022503', '20251112')],
      rfqDocuments: [me43('6000000054', '20260108')],
    });

    expect(merged.map((d) => d.documentNumber)).toEqual(['6000000054', '4500022503']);
  });

  it('keeps a document ME43 reports that ME48 missed', () => {
    const merged = mergeSapDocuments({
      quotationDocuments: [me48('4500022503', '20251112')],
      rfqDocuments: [me43('6000000059', '20260821')],
    });

    expect(merged.map((d) => d.documentNumber)).toEqual(['6000000059', '4500022503']);
  });

  it('fills a blank field from whichever read carries it', () => {
    // waers comes back empty on some rows and populated on others.
    const merged = mergeSapDocuments({
      quotationDocuments: [me48('6000000060', '20260821', { currency: null })],
      rfqDocuments: [me43('6000000060', '20260821', { currency: 'INR' })],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].currency).toBe('INR');
  });

  it('types an ME43 row, which carries no type of its own', () => {
    const [doc] = mergeSapDocuments({ rfqDocuments: [me43('6000000057', '20260520')], quotationDocuments: [] });
    expect(doc.documentType).toBe(DOCUMENT_TYPE.QUOTATION);
  });

  it('sorts newest first, whatever order SAP used', () => {
    // The live ME48 set is not date-ordered: a December document sits last.
    const merged = mergeSapDocuments({
      quotationDocuments: [
        me48('4500022787', '20260824'),
        me48('4500022562', '20261201'),
        me48('4500022503', '20251112'),
      ],
      rfqDocuments: [],
    });

    expect(merged.map((d) => d.date)).toEqual(['20261201', '20260824', '20251112']);
  });

  it('normalises the date to a string, since bedat arrives as a number', () => {
    const [doc] = mergeSapDocuments({ rfqDocuments: [me43('6000000057', 20260520)], quotationDocuments: [] });
    expect(doc.date).toBe('20260520');
  });

  it('drops a row with no document number rather than keying on null', () => {
    const merged = mergeSapDocuments({
      quotationDocuments: [me48(null, '20260101'), me48('4500022503', '20251112')],
      rfqDocuments: [],
    });

    expect(merged).toHaveLength(1);
  });

  describe('loading and failure', () => {
    it('is null only while neither read has answered', () => {
      expect(mergeSapDocuments({ rfqDocuments: null, quotationDocuments: null })).toBeNull();
    });

    it('shows what arrived when the other read failed', () => {
      // A failed read leaves its state null forever, so waiting for both would
      // be an endless spinner rather than a degraded list.
      const merged = mergeSapDocuments({ rfqDocuments: null, quotationDocuments: [me48('4500022503', '20251112')] });
      expect(merged).toHaveLength(1);
    });

    it('is an empty list, not null, when SAP genuinely has nothing', () => {
      expect(mergeSapDocuments({ rfqDocuments: [], quotationDocuments: [] })).toEqual([]);
    });
  });
});

describe('the summary line', () => {
  const documents = mergeSapDocuments({
    quotationDocuments: [me48('6000000054', '20260108'), me48('4500022503', '20251112'), me48('4500022504', '20251112')],
    rfqDocuments: [],
  });

  it('counts each type', () => {
    expect(countByType(documents)).toEqual({ quotations: 1, purchaseOrders: 2 });
  });

  it('reports the purchasing org only when every document shares one', () => {
    expect(commonPurchasingOrg(documents)).toBe('SSDN');
    expect(commonPurchasingOrg([...documents, { purchasingOrg: 'OTHR' }])).toBeNull();
    expect(commonPurchasingOrg([])).toBeNull();
  });
});
