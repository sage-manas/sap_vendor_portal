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

// A partial invoicing plan on line 10 — two instalments totalling the line's
// net value, which is what makes poInvoicePlanDisplay/Update worth calling in a
// conformance run rather than answering an empty plan list. poInvoicePlanDisplay
// is keyed on the plan number alone (GET /zinv_milestone/plan, not the PO), so
// a line without one is invisible to it — planNumber has to be a real value
// here, not null, or the display call against a live sandbox silently skips
// this line and "passes" without ever making the request.
const invoicePlan = {
  enabled: true,
  planNumber: '0000000010',
  type: 'Partial',
  startDate: new Date('2026-01-31T00:00:00Z'),
  endDate: new Date('2026-03-31T00:00:00Z'),
  currency: 'INR',
  lines: [
    { lineNumber: 10, description: 'On order', settlementDate: new Date('2026-01-31T00:00:00Z'), billingDate: new Date('2026-01-31T00:00:00Z'), percentage: 40, amount: 4000, status: 'Open', blocked: false },
    { lineNumber: 20, description: 'On delivery', settlementDate: new Date('2026-03-31T00:00:00Z'), billingDate: new Date('2026-03-31T00:00:00Z'), percentage: 60, amount: 6000, status: 'Open', blocked: false },
  ],
};

const po = {
  id: 'PO-CONFORMANCE-1',
  vendorId: 'vendor_conformance',
  sapPoNumber: '4500000001',
  currency: 'INR',
  acknowledgedAt: new Date(),
  items: [{ line: 10, materialCode: 'MAT-1', description: 'Test material', quantity: 100, grnQuantity: 0, unitPrice: 100, netValue: 10000, uom: 'EA', invoicePlan }],
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
  vendorReject: { vendor, reason: 'Conformance test rejection' },

  poAcknowledge: { po },

  poInvoicePlanDisplay: { po },
  poInvoicePlanUpdate: { po, item: po.items[0], plan: invoicePlan },

  awaitGoodsReceipt: { asn, po, vendorId: 'vendor_conformance' },

  awaitPaymentRun: { invoice, vendor, vendorId: 'vendor_conformance' },
};

module.exports = { FIXTURES, sapVendorCreateSettings };
