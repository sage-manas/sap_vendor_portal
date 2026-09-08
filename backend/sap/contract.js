// The SapAdapter contract.
//
// This is the whole surface between VendorConnect and an SAP system. Every
// method a controller can reach is declared here with the transaction it
// speaks; a driver that does not implement all of them fails to load, and
// Phase 8's conformance suite runs this list against a real system and reports
// pass/fail per method without knowing anything else about the drivers.
//
// Two kinds of method:
//
//   immediate — `fn(args) -> { data, log }`. The wrapper stamps `{source,
//               syncedAt}` on `data`, writes `log` to the SapLog, and returns.
//
//   deferred  — `fn(args, handler) -> Promise<boolean>`. SAP answers later, so
//               a deferred method is a one-shot probe: called once per
//               attempt by a durable job (jobs/worker.js — see
//               docs/04-sap-runtime-engineering-plan.md Phase 1), it resolves
//               `false` if SAP doesn't have an answer yet, `true` once it has
//               called `handler(data)` so the caller can persist the answer,
//               or throws on a genuine failure (which the job runtime treats
//               as an error to back off and retry, distinct from "not yet").
//               When `handler` runs the wrapper re-binds the tenant context
//               and writes the logs. Controllers therefore never schedule or
//               poll anything themselves — cadence and retry budget are the
//               job runtime's business (jobs/kinds.js) and the *bookkeeping*
//               is the wrapper's.
//
// `log` is `{ transaction, vendorId, payload, status?, documentRef }`, where
// `transaction` is a key from config/sapTransactions.js. Deferred methods
// return `{ data, logs: [...] }` instead, since one SAP answer can produce
// several entries.

const SAP_METHODS = {
  // Connectivity
  testConnection:   { transaction: 'PING',              logged: false },
  health:           { transaction: null,                logged: false },

  // Vendor master. Approval is a portal-only decision (never SAP-driven), so
  // vendorCreate is called from approveVendor once the client admin has said
  // yes — not at submission, and there is no deferred "SAP approves" method.
  vendorCreate:        { transaction: 'VENDOR_CREATE' },
  vendorVerifyKyc:     { transaction: 'VENDOR_KYC_VERIFY' },
  vendorReject:        { transaction: 'VENDOR_REJECT' },

  // Reference data VENDOR_CR's own fields are coded against (region, payment
  // terms, payment method) — read-only master-data lookups, not a business
  // transaction, so not logged to the tenant's SAP log like the methods above.
  vendorRegionCatalogue:        { transaction: null, logged: false },
  vendorPaymentTermsCatalogue:  { transaction: null, logged: false },
  vendorPaymentMethodCatalogue: { transaction: null, logged: false },

  // What SAP itself has posted (MIRO) for a vendor — a read against SAP's own
  // records, used to cross-check our internal Invoice/Payment tracking rather
  // than to drive it. Read-only, so not logged like a business transaction.
  vendorMiroDisplay: { transaction: null, logged: false, fields: { 'vendor.sapVendorCode': 'LIFNR' } },

  // Clearing/payment detail for one specific MIRO document (belnr+gjahr) —
  // the natural follow-up read once vendorMiroDisplay has told us which
  // documents SAP actually has. Also read-only.
  invoicePaymentDetail: { transaction: null, logged: false },

  // Every payment SAP has made to a vendor — the ledger behind the Payment
  // Tracking tab. Keyed on the vendor code alone, so unlike
  // invoicePaymentDetail it does not need to be told which documents to ask
  // about. Read-only, so not logged like a business transaction.
  vendorPaymentDisplay: { transaction: null, logged: false, fields: { 'vendor.sapVendorCode': 'LIFNR' } },

  // What SAP itself has issued (ME43 Display RFQ) to a vendor. Same family as
  // vendorMiroDisplay: a read against SAP's own records for cross-check, not
  // a correlation to our internal RFQ ids — this app's RFQ documents don't
  // carry an SAP RFQ number (sourcing is portal-internal — see below),
  // so this is shown as SAP's own ledger, not matched line-by-line.
  vendorRfqDisplay: { transaction: null, logged: false, fields: { 'vendor.sapVendorCode': 'LIFNR' } },

  // Every PO SAP has for a vendor, with line items and GRNs nested in —
  // fetched by vendor code directly. This is how purchase orders reach the
  // portal: read from SAP, never created here. Read-only, so not logged like a
  // business transaction.
  vendorPoGrnDisplay: { transaction: null, logged: false, fields: { 'vendor.sapVendorCode': 'LIFNR' } },

  // Every purchasing document SAP holds against a vendor code (ME48 Display
  // Quotation). Same read-only cross-check family as vendorRfqDisplay, but
  // note the name is SAP's, not a description: verified against the live
  // sandbox, ZCL_ME48/vendor returns the vendor's whole EKKO set — POs in the
  // 45xxxxxxx range as well as the 6xxxxxxx quotation/RFQ documents ME43
  // returns — with no document-category filter. Surfaced as what it is, a
  // purchasing-document ledger, rather than mislabelled "quotations".
  vendorQuotationDisplay: { transaction: null, logged: false, fields: { 'vendor.sapVendorCode': 'LIFNR' } },

  // Sourcing is portal-internal, with one confirmed exception.
  //
  // There is no rfqCreate/rfqCancel/rfqReissue/infoRecordCreate. Core S/4
  // exposes no public API for issuing an RFQ to, or capturing a bid from, an
  // external portal vendor — that is SAP Ariba/Business Network territory —
  // so these called a custom Z-OData "sourcing" service that was never built,
  // and threw on every real tenant. RFQs, bids and awards live in this
  // application; what SAP itself holds is read back through vendorRfqDisplay
  // and vendorQuotationDisplay.
  //
  // quotationUpdatePrice (ME47, ZQUOT_NETPR/QUOT_UPDPR) is the exception:
  // confirmed live against the sandbox, it updates the net price of line
  // items on a document SAP already holds (an `ebeln` from vendorRfqDisplay /
  // vendorQuotationDisplay's 6xxxxxxx range) — it does not create a bid
  // against a portal RFQ, which is why rfqSubmitBid above stays gone.
  quotationUpdatePrice: { transaction: 'QUOTATION_PRICE_UPDATE' },

  // Purchase orders
  // The portal does not create purchase orders in SAP, and does not announce
  // ones it holds. POST /pos/simulate and its poProvision/poProvisioned pair
  // are gone, and so is poInboundSync: awarding an RFQ creates a local order
  // with no SAP number, and real orders are read from SAP via
  // vendorPoGrnDisplay. Acknowledgement is the one thing a supplier tells SAP
  // about an order, and it is a change to a document SAP already owns.
  poAcknowledge:     { transaction: 'PO_ACKNOWLEDGE', fields: { 'po.sapPoNumber': 'EBELN' } },

  // Invoicing plans (ME22N → item → Invoicing Plan; tables FPLA/FPLT).
  //
  // A PO line item can carry an invoicing plan instead of being invoiced
  // against goods receipts: a periodic plan for a recurring charge, or a
  // partial plan splitting the line across milestone dates. Two methods,
  // because the plan is a thing SAP owns but the portal has to be able to both
  // read and set:
  //
  //   poInvoicePlanDisplay — read the plan SAP holds for an order. Read-only,
  //                          so unlogged like the other display methods.
  //   poInvoicePlanUpdate  — write a plan the buyer configured in the portal
  //                          back to the order. This IS a change to a document
  //                          SAP owns, same category as poAcknowledge, so it is
  //                          logged as a business transaction.
  //
  // poInvoicePlanDisplay is confirmed against the live sandbox
  // (GET /zinv_milestone/plan, keyed on the FPLA plan number rather than the
  // PO — see the note on it in s4odata.driver.js for what that changes).
  // poInvoicePlanUpdate has not been run against a live system yet; its path
  // and field names in s4odata.driver.js remain a provisional guess.
  poInvoicePlanDisplay: { transaction: null, logged: false, fields: { 'po.sapPoNumber': 'EBELN' } },
  poInvoicePlanUpdate:  { transaction: 'PO_INVOICE_PLAN_UPDATE', fields: { 'po.sapPoNumber': 'EBELN' } },

  // Delivery and goods receipt.
  //
  // There is no deliveryCreate: the portal does not write an inbound delivery
  // into SAP. A supplier's dispatch notice is recorded here and the goods
  // receipt is discovered by polling SAP's own PO/GRN ledger, matched on the
  // purchase order number rather than on a delivery document we issued.
  awaitGoodsReceipt: { transaction: 'GOODS_RECEIPT', deferred: true, fields: { 'po.sapPoNumber': 'EBELN' } },

  // Invoice and payment.
  //
  // There is no invoiceCreate either, and deliberately so: MIRO is invoice
  // verification, an AP clerk's transaction against the buyer's own books, not
  // something a supplier performs. The portal collects the invoice; AP posts it
  // in SAP on their own schedule; awaitPaymentRun finds the document SAP
  // actually holds (matched on invoice number, PO and amount) and follows it to
  // its payment. Nothing here mints a document number.
  awaitPaymentRun:   { transaction: 'PAYMENT_RUN', deferred: true, fields: { 'vendor.sapVendorCode': 'LIFNR', 'invoice.sapPoNumber': 'EBELN' } },
};

const METHOD_NAMES = Object.keys(SAP_METHODS);
const DEFERRED_METHODS = METHOD_NAMES.filter((name) => SAP_METHODS[name].deferred);

class NotImplementedError extends Error {
  constructor(driver, method) {
    super(`not_implemented: the ${driver} driver does not implement ${method}() yet`);
    this.name = 'NotImplementedError';
    this.code = 'not_implemented';
    this.statusCode = 501;
  }
}

// Raised when a driver refuses or fails a call. Distinct from a bug in our own
// code, because the circuit breaker counts these and only these.
class SapDriverError extends Error {
  constructor(message, { driver, method, cause } = {}) {
    super(message);
    this.name = 'SapDriverError';
    this.code = 'sap_call_failed';
    this.statusCode = 502;
    this.driver = driver;
    this.method = method;
    this.cause = cause;
  }
}

/**
 * Fails loudly at load time when a driver is missing a method, rather than at
 * 3pm on a Tuesday when someone finally submits an ASN.
 */
const assertImplements = (driver, name) => {
  const missing = METHOD_NAMES.filter((method) => typeof driver[method] !== 'function');
  if (missing.length) {
    throw new Error(`SAP driver "${name}" does not satisfy the contract: missing ${missing.join(', ')}`);
  }
  return driver;
};

/**
 * Builds a driver whose every contract method throws `not_implemented`. The
 * s4_odata and ecc_rfc skeletons start from this and override as they grow, so
 * a half-built driver is honest about which half is built.
 */
const notImplementedDriver = (name) =>
  Object.fromEntries(METHOD_NAMES.map((method) => [
    method,
    () => { throw new NotImplementedError(name, method); },
  ]));

module.exports = {
  SAP_METHODS,
  METHOD_NAMES,
  DEFERRED_METHODS,
  NotImplementedError,
  SapDriverError,
  assertImplements,
  notImplementedDriver,
};
