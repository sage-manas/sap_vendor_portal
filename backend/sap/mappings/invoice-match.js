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
//
// PO + amount alone is not enough once a periodic invoicing plan is involved
// (issue #64): a monthly plan bills the same amount against the same PO every
// period, so from the second invoice onward there are always at least two
// documents that fit. A date-proximity tiebreak (below) resolves most of
// those; when it can't, this throws AmbiguousInvoiceMatchError rather than
// silently returning "not found yet" — a job that keeps failing to match
// something ambiguous forever, and eventually gets marked `orphaned` for it,
// hides a real problem behind the wrong diagnosis. See
// jobs/handlers/awaitPaymentRun.js for what catches it.

// Amounts cross a JSON boundary and a currency conversion in SAP; a paise of
// slack avoids a float comparison failing on an exact match.
const AMOUNT_TOLERANCE = 0.01;

// How close a SAP document's own date has to be to the date the supplier put
// on their invoice to count as "probably the same one" once PO+amount alone
// leaves more than one candidate. Generous enough to absorb ordinary AP
// posting lag (a few days is normal), tight enough that two periods of the
// same monthly plan — at least ~28 days apart — never both qualify.
const DATE_TOLERANCE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

class AmbiguousInvoiceMatchError extends Error {
  constructor(candidates) {
    super(`${candidates.length} SAP documents match this invoice's purchase order and amount — cannot disambiguate`);
    this.name = 'AmbiguousInvoiceMatchError';
    this.candidates = candidates;
  }
}

const documentPoNumbers = (document) => {
  const fromItems = (document.items || []).map((item) => item.poNumber).filter(Boolean);
  return new Set([...fromItems, document.poNumber].filter(Boolean).map(String));
};

const parseDateMs = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};

/**
 * Finds the single SAP MIRO document that is this invoice.
 *
 * Returns null when nothing fits, or when more than one document fits and the
 * date tiebreak can't narrow it to one: paying a supplier against the wrong
 * invoice is far worse than showing them an invoice that has not been
 * recognised yet. Throws AmbiguousInvoiceMatchError instead of returning null
 * specifically for the "more than one fits" case (as opposed to "nothing
 * fits") — the two are different facts the caller needs to tell apart: one
 * means "AP hasn't posted this yet, keep waiting," the other means "AP
 * probably has, but this can't tell which one is ours."
 *
 * @param {{sapPoNumber: string, totalAmount: number, invoiceDate?: string|Date}} invoice
 * @param {Array} documents  as returned by vendorMiroDisplay
 */
const matchInvoiceDocument = (invoice, documents = []) => {
  if (!invoice?.sapPoNumber || invoice.totalAmount == null) return null;

  const wanted = String(invoice.sapPoNumber);
  const candidates = documents.filter((document) => {
    if (!document?.miroDoc || !documentPoNumbers(document).has(wanted)) return false;
    return Math.abs(Number(document.grossAmount) - Number(invoice.totalAmount)) <= AMOUNT_TOLERANCE;
  });

  if (candidates.length <= 1) return candidates[0] || null;

  const invoiceTime = parseDateMs(invoice.invoiceDate);
  if (invoiceTime != null) {
    const withinWindow = candidates.filter((document) => {
      const docTime = parseDateMs(document.docDate || document.postingDate);
      return docTime != null && Math.abs(docTime - invoiceTime) <= DATE_TOLERANCE_DAYS * DAY_MS;
    });
    if (withinWindow.length === 1) return withinWindow[0];
  }

  throw new AmbiguousInvoiceMatchError(candidates);
};

module.exports = { matchInvoiceDocument, AmbiguousInvoiceMatchError, AMOUNT_TOLERANCE, DATE_TOLERANCE_DAYS };
