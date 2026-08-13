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
//   deferred  — `fn(args, handler) -> void`. SAP answers later: the mock driver
//               uses a timer, a real driver would poll or take a webhook. When
//               the answer arrives the wrapper re-binds the tenant context,
//               calls `handler(data)` so the caller can persist it, then writes
//               the logs. Controllers therefore never schedule anything
//               themselves — the *timing* is the driver's business and the
//               *bookkeeping* is theirs.
//
// `log` is `{ transaction, vendorId, payload, status?, documentRef }`, where
// `transaction` is a key from config/sapTransactions.js. Deferred methods
// return `{ data, logs: [...] }` instead, since one SAP answer can produce
// several entries.

const SAP_METHODS = {
  // Connectivity
  testConnection:   { transaction: 'PING',              logged: false },
  health:           { transaction: null,                logged: false },

  // Vendor master
  vendorCreate:        { transaction: 'VENDOR_CREATE' },
  vendorVerifyKyc:     { transaction: 'VENDOR_KYC_VERIFY' },
  vendorConfirm:       { transaction: 'VENDOR_CONFIRM' },
  vendorReject:        { transaction: 'VENDOR_REJECT' },
  awaitVendorApproval: { transaction: 'VENDOR_CONFIRM', deferred: true },

  // Sourcing
  rfqCreate:         { transaction: 'RFQ_CREATE' },
  rfqCancel:         { transaction: 'RFQ_CANCEL' },
  rfqReissue:        { transaction: 'RFQ_REISSUE' },
  rfqSubmitBid:      { transaction: 'RFQ_SUBMIT_BID' },
  infoRecordCreate:  { transaction: 'INFORECORD_CREATE' },

  // Purchase orders
  poInboundSync:     { transaction: 'PO_INBOUND_SYNC' },
  // Two halves of one exchange: SAP hands over a purchase order, we give it a
  // per-tenant business id, and only then can the inbound call be logged
  // against a document reference that means something.
  poProvision:       { transaction: null, logged: false },
  poProvisioned:     { transaction: 'PO_PROCESS_SRV' },
  poAcknowledge:     { transaction: 'PO_ACKNOWLEDGE' },

  // Delivery and goods receipt
  deliveryCreate:    { transaction: 'DELIVERY_CREATE' },
  awaitGoodsReceipt: { transaction: 'GOODS_RECEIPT', deferred: true },

  // Invoice and payment
  invoiceCreate:     { transaction: 'INVOICE_CREATE' },
  awaitPaymentRun:   { transaction: 'PAYMENT_RUN', deferred: true },
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
