// Matching a portal invoice to the MIRO document SAP actually holds.
//
// The portal does not post invoices into SAP — MIRO is invoice verification,
// an AP clerk's transaction against the buyer's own books (see the comment on
// awaitPaymentRun in sap/contract.js). So there is no document number we issued
// and can look up later: the portal has to *recognise* its invoice in SAP's
// ledger from facts both systems independently know.
//
// Two callers need that rule and must agree exactly — the payment poll in
// drivers/s4odata.driver.js and the reconciliation view in
// controllers/invoice.controller.js — so it lives here once.
//
// The match keys are the purchase order and the gross amount. Deliberately not
// the supplier's invoice number: zmiro_display/MIRO returns REFERENCE in the
// header, and whether that field carries the PO or the supplier's own invoice
// number is a per-configuration choice in SAP (XBLNR conventionally holds the
// supplier reference, but this sandbox's mapping is unconfirmed). The line
// items carry PO_NO unambiguously, so the PO is read from there first.

// Amounts cross a JSON boundary and a currency conversion in SAP; a paise of
// slack avoids a float comparison failing on an exact match.
const AMOUNT_TOLERANCE = 0.01;

const documentPoNumbers = (document) => {
  const fromItems = (document.items || []).map((item) => item.poNumber).filter(Boolean);
  return new Set([...fromItems, document.poNumber].filter(Boolean).map(String));
};

/**
 * Finds the single SAP MIRO document that is this invoice, or null.
 *
 * Returns null rather than guessing when more than one document fits: paying a
 * supplier against the wrong invoice is far worse than showing them an invoice
 * that has not been recognised yet, and a human can always resolve an ambiguity
 * that this cannot.
 *
 * @param {{sapPoNumber: string, totalAmount: number}} invoice
 * @param {Array} documents  as returned by vendorMiroDisplay
 */
const matchInvoiceDocument = (invoice, documents = []) => {
  if (!invoice?.sapPoNumber || invoice.totalAmount == null) return null;

  const wanted = String(invoice.sapPoNumber);
  const candidates = documents.filter((document) => {
    if (!document?.miroDoc || !documentPoNumbers(document).has(wanted)) return false;
    return Math.abs(Number(document.grossAmount) - Number(invoice.totalAmount)) <= AMOUNT_TOLERANCE;
  });

  return candidates.length === 1 ? candidates[0] : null;
};

module.exports = { matchInvoiceDocument, AMOUNT_TOLERANCE };
