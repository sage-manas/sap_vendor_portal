// Issue #62: zpo_grn_vendor/Detail answers on the vendor code (LIFNR) alone —
// it has no company-code filter of its own — so a supplier trading with more
// than one company code in the same SAP client would otherwise have every
// order pulled into whichever single tenant asked, across entities. The
// driver filters by the tenant's declared company codes itself, so nothing
// outside scope ever reaches a caller that might persist it.
const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');

/**
 * Stubs Node's `http.request` — the transport zpo_grn_vendor/Detail's
 * GET-with-a-JSON-body call uses (getWithBody in s4odata.driver.js). See
 * tests/sap-read-contracts.test.js for the original of this helper.
 */
const mockHttpRequest = (responseBody) => {
  const http = require('http');
  const original = http.request;
  http.request = (url, options, callback) => {
    const req = {
      write: () => {},
      end: () => {
        callback({
          statusCode: 200,
          statusMessage: 'OK',
          on: (event, handler) => {
            if (event === 'data') handler(Buffer.from(responseBody));
            if (event === 'end') handler();
          },
        });
      },
      on: () => {},
      destroy: () => {},
    };
    return req;
  };
  return { restore: () => { http.request = original; } };
};

const poRow = (poNumber, companyCode) => ({
  PO_NUMBER: poNumber,
  PO_DATE: '01.01.2026',
  BUYER_NAME: 'Buyer',
  SHIP_TO_CITY: 'Pune',
  SHIP_TO_STATE: 'MH',
  COM_CODE: companyCode,
  CURRENCY: 'INR',
  PO_LINE_ITEMS: [{
    ITEM_NUMBER: '10', MATERIAL_CODE: 'MAT-1', DESCRIPTION: 'Widget',
    ORDERED_QUANTITY: '10', RECEIVED_QUANTITY: '0', INVOICED_QUANTITY: '0',
    UOM: 'EA', UNIT_PRICE: '50', NET_AMOUNT: '500', GROSS_AMOUNT: '590', PLANT: '1000',
    GRN: [],
  }],
});

const driverFor = (config = {}) => createS4ODataDriver({
  config: { baseUrl: 'http://sandbox', sapClient: '800', ...config },
  secrets: {},
});

describe('vendorPoGrnDisplay — company-code scoping (issue #62)', () => {
  it('drops an order outside the tenant\'s declared company codes', async () => {
    const { restore } = mockHttpRequest(JSON.stringify([poRow('4500000001', '1000'), poRow('4500000002', '2000')]));
    let result;
    try {
      result = await driverFor({ companyCode: '1000' }).vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
    } finally { restore(); }

    expect(result.data.orders.map((o) => o.poNumber)).toEqual(['4500000001']);
  });

  it('accepts a comma-separated companyCodes list wider than the single required companyCode', async () => {
    const { restore } = mockHttpRequest(JSON.stringify([poRow('4500000001', '1000'), poRow('4500000002', '2000'), poRow('4500000003', '3000')]));
    let result;
    try {
      result = await driverFor({ companyCode: '1000', companyCodes: '1000, 2000' }).vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
    } finally { restore(); }

    expect(result.data.orders.map((o) => o.poNumber).sort()).toEqual(['4500000001', '4500000002']);
  });

  it('falls back to the single required companyCode when companyCodes is not set', async () => {
    const { restore } = mockHttpRequest(JSON.stringify([poRow('4500000001', '1000'), poRow('4500000002', '2000')]));
    let result;
    try {
      result = await driverFor({ companyCode: '2000' }).vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
    } finally { restore(); }

    expect(result.data.orders.map((o) => o.poNumber)).toEqual(['4500000002']);
  });
});

describe('vendorPoGrnDisplay — drops RFQ documents this endpoint mixes in', () => {
  // Confirmed live: zpo_grn_vendor/Detail answers with a vendor's whole
  // purchasing-document set, RFQs in the 6xxxxxxx range included, despite
  // being the PO/GRN detail read — jobs/handlers/sweepPurchaseOrders.js had
  // no other signal to tell one from a real order, so it created a bogus
  // PurchaseOrder row (₹0 value, no GRNs) for each RFQ it saw here. Same
  // number-range rule src/lib/sapDocuments.js's documentTypeOf already uses.
  it('excludes a 6xxxxxxx document, keeping only real (45xxxxxxx) orders', async () => {
    const { restore } = mockHttpRequest(JSON.stringify([
      poRow('4500098001', '1000'),
      poRow('6000000072', '1000'),
    ]));
    let result;
    try {
      result = await driverFor({ companyCode: '1000' }).vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
    } finally { restore(); }

    expect(result.data.orders.map((o) => o.poNumber)).toEqual(['4500098001']);
  });

  it('is not fooled by a company-code mismatch masking as the fix — both filters apply together', async () => {
    const { restore } = mockHttpRequest(JSON.stringify([
      poRow('4500098001', '1000'),
      poRow('4500098002', '2000'), // wrong company code
      poRow('6000000072', '1000'), // RFQ range
    ]));
    let result;
    try {
      result = await driverFor({ companyCode: '1000' }).vendorPoGrnDisplay({ vendor: { sapVendorCode: 'VEN0001' } });
    } finally { restore(); }

    expect(result.data.orders.map((o) => o.poNumber)).toEqual(['4500098001']);
  });
});

describe('validateConfig — company code is required (issue #62)', () => {
  const { validateConfig } = require('../sap/drivers/s4odata.driver');

  it('refuses a connection with no company code, rather than defaulting to \'1000\'', () => {
    const errors = validateConfig({ baseUrl: 'https://s4.example.com', sapClient: '100' });
    expect(errors.companyCode).toBeTruthy();
  });

  it('accepts one that declares a company code', () => {
    const errors = validateConfig({ baseUrl: 'https://s4.example.com', sapClient: '100', companyCode: '1000' });
    expect(errors.companyCode).toBeUndefined();
  });
});

describe('validateConfig — production requires credentials (issue #79)', () => {
  const { validateConfig } = require('../sap/drivers/s4odata.driver');
  const validConfig = { baseUrl: 'https://s4.example.com', sapClient: '100', companyCode: '1000' };

  it('does not require credentials when no environment is given (an unsaved "test connection" config)', () => {
    const errors = validateConfig(validConfig);
    expect(errors.credentials).toBeUndefined();
  });

  it('does not require credentials for a sandbox connection', () => {
    const errors = validateConfig(validConfig, { environment: 'sandbox', secrets: {} });
    expect(errors.credentials).toBeUndefined();
  });

  it('requires credentials for a production connection', () => {
    const errors = validateConfig(validConfig, { environment: 'production', secrets: {} });
    expect(errors.credentials).toMatch(/technical user/i);
    expect(errors.credentials).toMatch(/password/i);
  });

  it('accepts a production connection once both credentials are present', () => {
    const errors = validateConfig(validConfig, { environment: 'production', secrets: { username: 'RFCUSER', password: 'x' } });
    expect(errors.credentials).toBeUndefined();
  });
});
