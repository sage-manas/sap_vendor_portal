// sap/mappings/goods-receipt-match.js — which SAP goods receipt belongs to
// which shipment notice, now that an order can carry several. Pure: the
// order is shaped as vendorPoGrnDisplay returns it, no SAP and no database.
const { pickGoodsReceiptForAsn } = require('../sap/mappings/goods-receipt-match');

const gr = (grNumber, grDate, quantity) => ({ grNumber, grYear: 2026, grDate, quantity });

const order = (lines) => ({
  items: Object.entries(lines).map(([itemNumber, grns]) => ({ itemNumber: String(itemNumber).padStart(5, '0'), grns })),
});

const asn = (lines, submittedAt = '2026-11-10T09:00:00Z') => ({ submittedAt, items: lines.map((line) => ({ line })) });

describe('pickGoodsReceiptForAsn', () => {
  it('takes one receipt document, with only its own quantity — not the line\'s running total', () => {
    const picked = pickGoodsReceiptForAsn({
      asn: asn([10]),
      order: order({ 10: [gr('5000000001', '2026-11-12', 40), gr('5000000002', '2026-11-14', 60)] }),
      recordedIds: new Set(),
    });

    expect(picked.id).toBe('GRN-2026-5000000001');
    expect(picked.quantityByLine.get(10)).toBe(40);
  });

  it('skips a receipt the portal has already recorded against another shipment', () => {
    const picked = pickGoodsReceiptForAsn({
      asn: asn([10]),
      order: order({ 10: [gr('5000000001', '2026-11-12', 40), gr('5000000002', '2026-11-14', 60)] }),
      recordedIds: new Set(['GRN-2026-5000000001']),
    });

    expect(picked.id).toBe('GRN-2026-5000000002');
    expect(picked.quantityByLine.get(10)).toBe(60);
  });

  it('ignores a receipt posted before the shipment was even announced', () => {
    const picked = pickGoodsReceiptForAsn({
      asn: asn([10], '2026-11-20T09:00:00Z'),
      order: order({ 10: [gr('5000000001', '2026-11-12', 40)] }),
      recordedIds: new Set(),
    });

    expect(picked).toBeNull();
  });

  it('allows a day of slack for SAP\'s local posting date against a UTC timestamp', () => {
    // Submitted 20 Nov 01:00 IST is still 19 Nov in UTC; SAP posts 19 Nov.
    const picked = pickGoodsReceiptForAsn({
      asn: asn([10], '2026-11-19T19:30:00Z'),
      order: order({ 10: [gr('5000000001', '2026-11-19', 40)] }),
      recordedIds: new Set(),
    });

    expect(picked?.id).toBe('GRN-2026-5000000001');
  });

  it('collects one document across every shipped line it covers, and nothing from unshipped lines', () => {
    const picked = pickGoodsReceiptForAsn({
      asn: asn([10, 20]),
      order: order({
        10: [gr('5000000001', '2026-11-12', 40)],
        20: [gr('5000000001', '2026-11-12', 5)],
        30: [gr('5000000001', '2026-11-12', 99)],
      }),
      recordedIds: new Set(),
    });

    expect([...picked.quantityByLine]).toEqual([[10, 40], [20, 5]]);
  });

  describe('once SAP reports the inbound delivery on each receipt (ADR-0049)', () => {
    const grAgainst = (grNumber, grDate, quantity, inboundDelivery) => ({ ...gr(grNumber, grDate, quantity), inboundDelivery });

    it('takes the receipt posted against this shipment\'s delivery, even when an earlier one exists', () => {
      const picked = pickGoodsReceiptForAsn({
        asn: { ...asn([10]), sapInboundDelivery: '0180000002' },
        order: order({ 10: [grAgainst('5000000001', '2026-11-12', 40, '0180000001'), grAgainst('5000000002', '2026-11-14', 60, '180000002')] }),
        recordedIds: new Set(),
      });

      expect(picked.id).toBe('GRN-2026-5000000002');
    });

    it('never gives a shipment without a delivery a receipt that names another delivery', () => {
      const picked = pickGoodsReceiptForAsn({
        asn: asn([10]),
        order: order({ 10: [grAgainst('5000000001', '2026-11-12', 40, '0180000001')] }),
        recordedIds: new Set(),
      });

      expect(picked).toBeNull();
    });
  });

  it('answers null — not yet — while no unrecorded receipt touches a shipped line', () => {
    const picked = pickGoodsReceiptForAsn({
      asn: asn([10]),
      order: order({ 10: [], 20: [gr('5000000001', '2026-11-12', 5)] }),
      recordedIds: new Set(),
    });

    expect(picked).toBeNull();
  });
});
