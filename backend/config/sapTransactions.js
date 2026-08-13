// The single registry of SAP transactions this product speaks.
//
// Before Phase 4 these names were string literals scattered across five
// controllers, each one paired with a hand-written `type` and `direction` that
// nothing checked. A typo produced a SapLog row that no filter would ever
// match, and adding a call meant remembering three facts in one place.
//
// Now a transaction is declared once — code, type, direction, and the plain
// sentence a human reads in the log viewer — and the drivers look it up. A call
// naming an unregistered transaction throws (see `transaction()` below), which
// is the same bargain `config/auditActions.js` makes for the audit trail.

const SAP_TRANSACTIONS = {
  // Vendor master (XK01 / MK01 family)
  VENDOR_CREATE:      { code: 'BAPI_VENDOR_CREATE',        type: 'BAPI',  direction: 'OUTBOUND', label: 'Create vendor master record' },
  VENDOR_CONFIRM:     { code: 'OData_VENDOR_CONFIRM',      type: 'OData', direction: 'INBOUND',  label: 'Vendor master confirmed' },
  VENDOR_REJECT:      { code: 'OData_VENDOR_REJECT',       type: 'OData', direction: 'INBOUND',  label: 'Vendor master rejected' },
  VENDOR_KYC_VERIFY:  { code: 'GSTIN_PAN_VERIFY',          type: 'KYC',   direction: 'OUTBOUND', label: 'GSTIN and PAN verification' },

  // Sourcing (ME41 / ME47 family)
  RFQ_CREATE:         { code: 'BAPI_RFQ_CREATE',           type: 'BAPI',  direction: 'OUTBOUND', label: 'Create request for quotation' },
  RFQ_CANCEL:         { code: 'RFC_RFQ_CANCEL',            type: 'RFC',   direction: 'OUTBOUND', label: 'Cancel request for quotation' },
  RFQ_REISSUE:        { code: 'RFC_RFQ_REISSUE',           type: 'RFC',   direction: 'OUTBOUND', label: 'Reissue request for quotation' },
  RFQ_SUBMIT_BID:     { code: 'RFC_RFQ_SUBMIT_BID',        type: 'RFC',   direction: 'OUTBOUND', label: 'Submit quotation' },
  INFORECORD_CREATE:  { code: 'BAPI_INFORECORD_CREATE',    type: 'BAPI',  direction: 'OUTBOUND', label: 'Create purchasing info record' },

  // Purchase orders (ME21N / ME29N)
  PO_INBOUND_SYNC:    { code: 'OData_PO_INBOUND_SYNC',     type: 'OData', direction: 'INBOUND',  label: 'Purchase order inbound sync' },
  PO_PROCESS_SRV:     { code: '/API_PURCHASEORDER_PROCESS_SRV', type: 'OData', direction: 'INBOUND', label: 'Purchase order process service' },
  PO_ACKNOWLEDGE:     { code: 'RFC_PO_ACKNOWLEDGE',        type: 'RFC',   direction: 'OUTBOUND', label: 'Acknowledge purchase order' },

  // Inbound delivery and goods receipt (VL31N / MIGO)
  DELIVERY_CREATE:    { code: 'BAPI_DELIVERYPROCESSING_EXEC', type: 'RFC', direction: 'OUTBOUND', label: 'Create inbound delivery' },
  GOODS_RECEIPT:      { code: 'BAPI_GOODSMVT_CREATE',      type: 'BAPI',  direction: 'INBOUND',  label: 'Post goods receipt' },
  GOODS_RECEIPT_READ: { code: 'BAPI_GOODSMVT_GETDETAIL',   type: 'RFC',   direction: 'INBOUND',  label: 'Read goods receipt detail' },

  // Invoice and payment (MIRO / F110 / FBL1N)
  INVOICE_CREATE:     { code: 'BAPI_INCOMINGINVOICE_CREATE', type: 'BAPI', direction: 'OUTBOUND', label: 'Post incoming invoice' },
  PAYMENT_RUN:        { code: 'FBL1N_RFITEMGL',            type: 'OData', direction: 'INBOUND',  label: 'Payment run clearing' },

  // Connectivity — not a business document, but it is a call to SAP and it
  // belongs in the same log as everything else.
  PING:               { code: 'RFC_PING',                  type: 'SYS',   direction: 'OUTBOUND', label: 'Connection test' },
};

const ALL_TRANSACTIONS = Object.values(SAP_TRANSACTIONS);

/**
 * Looks a transaction up by registry key. Throws on an unknown key, because an
 * unregistered transaction is a programming error that would otherwise only
 * show up as an unfilterable row in the SAP log weeks later.
 */
const transaction = (key) => {
  const entry = SAP_TRANSACTIONS[key];
  if (!entry) {
    throw new Error(`Unknown SAP transaction "${key}" — add it to config/sapTransactions.js`);
  }
  return entry;
};

const TRANSACTION_KEYS = Object.keys(SAP_TRANSACTIONS);

module.exports = { SAP_TRANSACTIONS, ALL_TRANSACTIONS, TRANSACTION_KEYS, transaction };
