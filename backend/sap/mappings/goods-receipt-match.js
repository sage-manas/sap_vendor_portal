// Which SAP goods receipt belongs to which shipment notice.
//
// zpo_grn_vendor/Detail reports receipts per PO line, with nothing that says
// which delivery they were for — SAP never saw the portal's ASN. While an
// order could only have one ASN that did not matter: the first receipt on the
// order was that ASN's. Once an order can ship in parts it does. Taking the
// first receipt on the line again would hand the second shipment the first
// shipment's goods, and the line's total received quantity would credit it
// with both.
//
// So a receipt is matched by elimination and by date:
//
//   - one GR document (GR_NUMBER + its fiscal year) is one receipt, even
//     though its number repeats on every PO line it covers;
//   - a document the portal has already recorded — against another ASN, or by
//     the sweep with none — is not a candidate;
//   - a document dated before the ASN was submitted cannot be for it. A day of
//     slack absorbs the gap between SAP's local posting date and UTC;
//   - of what is left, the earliest document that touches any shipped line is
//     this shipment's receipt, and only its own quantities are counted.
//
// That rule is a best guess where SAP gives no key, and it is wrong when the
// warehouse splits one truck across two MIGO postings: the second posting is
// left for the sweep to record without an ASN.
//
// Where SAP does give a key it wins (ADR-0049). Once the portal has created
// an inbound delivery for the ASN and the receipt feed reports the delivery
// each receipt was posted against (MSEG-VBELN_IM, `inboundDelivery`):
//
//   - only receipts against this ASN's delivery are candidates;
//   - a receipt against some other delivery is never a candidate for any
//     ASN, with or without one of its own — it belongs to that delivery.
//
// The date and already-recorded rules still apply on top.

const DAY_MS = 86400000;

const receiptId = (year, grNumber) => `GRN-${year}-${grNumber}`;

// VBELN is ten characters with leading zeros in SAP and is not always echoed
// back padded the same way.
const sameDelivery = (a, b) => Boolean(a && b) && String(a).replace(/^0+/, '') === String(b).replace(/^0+/, '');

/**
 * @param {object} args
 * @param {object} args.asn - { submittedAt, sapInboundDelivery?, items: [{ line }] }
 * @param {object} args.order - one order from vendorPoGrnDisplay: { items: [{ itemNumber, grns: [...] }] }
 * @param {Set<string>} args.recordedIds - GRN ids the portal already holds
 * @returns {null | { id, grNumber, year, date, quantityByLine: Map<number, number> }}
 */
const pickGoodsReceiptForAsn = ({ asn, order, recordedIds }) => {
  const shippedLines = new Set((asn.items || []).map((item) => Number(item.line)));
  const notBefore = asn.submittedAt
    ? new Date(new Date(asn.submittedAt).getTime() - DAY_MS).toISOString().slice(0, 10)
    : null;

  const docs = new Map();
  for (const item of order.items || []) {
    const line = Number(item.itemNumber);
    if (!shippedLines.has(line)) continue;

    for (const gr of item.grns || []) {
      if (!gr.grNumber || !gr.grYear) continue;
      const id = receiptId(gr.grYear, gr.grNumber);
      if (recordedIds.has(id)) continue;
      if (notBefore && gr.grDate && gr.grDate < notBefore) continue;
      // Posted against a delivery: it is that delivery's receipt, so it is a
      // candidate only for the ASN that delivery was created for.
      if (gr.inboundDelivery && !sameDelivery(gr.inboundDelivery, asn.sapInboundDelivery)) continue;

      const doc = docs.get(id) || {
        id, grNumber: gr.grNumber, year: gr.grYear, date: gr.grDate || null, quantityByLine: new Map(),
      };
      doc.quantityByLine.set(line, (doc.quantityByLine.get(line) || 0) + (Number(gr.quantity) || 0));
      docs.set(id, doc);
    }
  }

  if (!docs.size) return null;

  // Earliest posting date first; the document number breaks a same-day tie,
  // since SAP allocates them in order.
  return [...docs.values()].sort((a, b) => (a.date || '').localeCompare(b.date || '')
    || String(a.grNumber).localeCompare(String(b.grNumber)))[0];
};

module.exports = { pickGoodsReceiptForAsn, receiptId, sameDelivery };
