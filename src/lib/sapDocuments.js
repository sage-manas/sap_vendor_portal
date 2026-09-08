// One list of the purchasing documents SAP holds against a vendor's code.
//
// Two reads answer overlapping questions about the same vendor:
//
//   ME43  (ZME43/ME43)        the RFQ/quotation documents SAP issued to them
//   ME48  (ZCL_ME48/vendor)   their whole purchasing set — purchase orders in
//                             the 45xxxxxxx range *and* the 6xxxxxxx quotation
//                             documents ME43 returns
//
// So ME48 is expected to contain everything ME43 does. Both are called anyway:
// the two are the same handler on the SAP side differing only in selection, and
// if ME43 ever reports a document ME48 misses, the supplier should still see it.
// The cost of that is a document arriving twice, which is what the dedupe below
// is for — and why this rule lives in one tested place rather than in a screen.
//
// The two reads also name the same field differently (`sapRfqNumber` vs
// `documentNumber`), so normalising comes first.

export const DOCUMENT_TYPE = {
  QUOTATION: 'Quotation',
  PURCHASE_ORDER: 'Purchase Order',
};

// SAP names no document category in either response. The number range is the
// only signal: 6xxxxxxx is the RFQ/quotation range on this system, and every
// other range observed is a purchase order. The ME48 read already classifies
// server-side; this is the fallback for ME43 rows, which carry no type.
export const documentTypeOf = (documentNumber) =>
  (String(documentNumber || '').startsWith('6')
    ? DOCUMENT_TYPE.QUOTATION
    : DOCUMENT_TYPE.PURCHASE_ORDER);

const normalise = (doc) => {
  const documentNumber = doc.documentNumber || doc.sapRfqNumber || null;
  return {
    documentNumber,
    documentType: doc.documentType || documentTypeOf(documentNumber),
    // Both drivers emit SAP's YYYYMMDD as a string; kept as one so sorting and
    // formatting do not have to care which read produced the row.
    date: doc.date != null ? String(doc.date) : null,
    currency: doc.currency || null,
    purchasingOrg: doc.purchasingOrg || null,
  };
};

// The same document from both reads is one document. Fields are filled in from
// whichever copy has them — one read leaves `waers` empty where the other
// carries it — rather than letting arrival order decide what the vendor sees.
const absorb = (existing, incoming) => ({
  documentNumber: existing.documentNumber,
  documentType: existing.documentType || incoming.documentType,
  date: existing.date || incoming.date,
  currency: existing.currency || incoming.currency,
  purchasingOrg: existing.purchasingOrg || incoming.purchasingOrg,
});

/**
 * Merges the two reads into one list, newest first.
 *
 * Returns `null` only while *neither* read has answered, so a screen can tell
 * "still loading" from "SAP has nothing". If one read fails and the other
 * succeeds the vendor sees what did arrive rather than an endless spinner.
 *
 * @param {Array|null} rfqDocuments         from GET /rfqs/sap-status   (ME43)
 * @param {Array|null} quotationDocuments   from GET /rfqs/sap-quotations (ME48)
 */
export const mergeSapDocuments = ({ rfqDocuments, quotationDocuments }) => {
  const haveRfq = Array.isArray(rfqDocuments);
  const haveQuotation = Array.isArray(quotationDocuments);
  if (!haveRfq && !haveQuotation) return null;

  const byNumber = new Map();
  for (const raw of [...(quotationDocuments || []), ...(rfqDocuments || [])]) {
    const doc = normalise(raw);
    if (!doc.documentNumber) continue;

    const existing = byNumber.get(doc.documentNumber);
    byNumber.set(doc.documentNumber, existing ? absorb(existing, doc) : doc);
  }

  return [...byNumber.values()]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
};

/** How many of each type, for the summary line above the table. */
export const countByType = (documents = []) => ({
  quotations: documents.filter((d) => d.documentType === DOCUMENT_TYPE.QUOTATION).length,
  purchaseOrders: documents.filter((d) => d.documentType === DOCUMENT_TYPE.PURCHASE_ORDER).length,
});

/** The purchasing org, when every document shares one — otherwise null. */
export const commonPurchasingOrg = (documents = []) => {
  const orgs = [...new Set(documents.map((d) => d.purchasingOrg).filter(Boolean))];
  return orgs.length === 1 ? orgs[0] : null;
};
