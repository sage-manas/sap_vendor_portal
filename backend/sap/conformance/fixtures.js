// Representative arguments for every SapAdapter contract method — what a
// controller would actually pass, minus the database round-trip that would
// normally produce it. The conformance suite (and its own tests) call every
// method the same way regardless of which driver is behind it, so a real
// driver's partial progress shows up honestly instead of behind fixtures
// hand-tuned to whatever happens to work.
//
// Shapes mirror sap/drivers/mock.driver.js, which is the one driver that
// reads every field below.

const vendor = {
  _id: 'VENDORDOC-CONFORMANCE-1',
  vendorId: 'vendor_conformance',
  companyName: 'Conformance Testing Pvt Ltd',
  gstin: '27AAAPL1234C1ZV',
  pan: 'AAAPL1234C',
  email: 'conformance@example.com',
  phone: '+91 22 4000 1000',
  address: '1 Conformance Way',
  city: 'Mumbai',
  country: 'IN',
  region: 'MH',
  postalCode: '400001',
  paymentTerms: 'Net 30',
  paymentMethod: 'NEFT',
  currency: 'INR',
  incoterms1: 'FOB',
  incoterms2: 'Mumbai Port',
  doubleInvoiceCheck: true,
  grBasedInvoiceVerification: true,
  sapVendorCode: null,
};

// The tenant's VENDOR_CR system-controlled fields (config/tenantSettings.js
// group 'sapVendorCreate') — Phase 7. Placeholder values for conformance
// runs only; a real tenant configures these once via the workspace settings
// screen. Field names/values are unverified against a live SAP system, same
// caveat as sap/mappings/vendor-create.map.js.
// Shaped after the values the live VENDOR_CR contract was confirmed with, so a
// conformance run exercises the same kinds of value a real tenant sends.
const sapVendorCreateSettings = {
  accountGroup: 'SSDN',
  industry: 'ZENT',
  language: 'E',
  companyCode: 'SSDN',
  reconciliationAccount: '0000040000',
  planningGroup: 'A1',
  accountStatement: '1',
  purchasingOrganization: '1000',
  schemaGroupVendor: '01',
};

const rfq = {
  id: 'RFQ-CONFORMANCE-1',
  rfqType: 'Standard',
  deadlineDate: new Date(),
  purchasingGroup: '001',
  paymentTerms: 'NET 30',
  items: [{ line: 10, materialCode: 'MAT-1', description: 'Test material', quantity: 100, uom: 'EA' }],
};

const po = {
  id: 'PO-CONFORMANCE-1',
  vendorId: 'vendor_conformance',
  acknowledgedAt: new Date(),
  items: [{ line: 10, materialCode: 'MAT-1', description: 'Test material', quantity: 100, grnQuantity: 0, unitPrice: 100, netValue: 10000, uom: 'EA' }],
};

const asn = {
  id: 'ASN-CONFORMANCE-1',
  vendorId: 'vendor_conformance',
  shipDate: new Date(),
  carrierName: 'Test Carrier',
  trackingNumber: 'TRACK-1',
  items: [{ line: 10, materialCode: 'MAT-1', description: 'Test material', shippedQuantity: 100, uom: 'EA' }],
};

const invoice = {
  id: 'INV-CONFORMANCE-1',
  vendorId: 'vendor_conformance',
  invoiceDate: new Date(),
  currency: 'INR',
  totalAmount: 10000,
  items: [{ line: 10, materialCode: 'MAT-1', quantity: 100, unitPrice: 100 }],
};

const FIXTURES = {
  testConnection: {},
  health: {},

  vendorCreate: { vendor, settings: sapVendorCreateSettings },
  vendorVerifyKyc: { vendor, result: { gstinValid: true, panValid: true } },
  vendorConfirm: { vendor },
  vendorReject: { vendor, reason: 'Conformance test rejection' },
  awaitVendorApproval: { vendor },

  rfqCreate: { rfq, vendorId: 'SYSTEM' },
  rfqCancel: { rfq },
  rfqReissue: { rfq },
  rfqSubmitBid: {
    rfq,
    vendorId: 'vendor_conformance',
    bid: { unitPrices: [100], taxCode: 'V0', deliveryLeadTimeDays: 7, validityDate: new Date() },
  },
  infoRecordCreate: { rfq, vendorId: 'vendor_conformance', items: rfq.items },

  poInboundSync: { po, vendorId: 'vendor_conformance' },
  poProvision: { vendorId: 'vendor_conformance' },
  poProvisioned: { po, vendorId: 'vendor_conformance' },
  poAcknowledge: { po },

  deliveryCreate: { asn, po, vendorId: 'vendor_conformance' },
  awaitGoodsReceipt: { asn, po, vendorId: 'vendor_conformance' },

  invoiceCreate: { invoice, vendorId: 'vendor_conformance' },
  awaitPaymentRun: { invoice, vendor, vendorId: 'vendor_conformance' },
};

module.exports = { FIXTURES, sapVendorCreateSettings };
