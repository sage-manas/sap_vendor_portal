const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');

// The exact response ZCL_ME48/vendor returns on the live sandbox, captured from
//   GET /ZCL_ME48/vendor?sap-client=800&LIFNR=1120250010
// Trimmed to the rows that carry a distinct case; the shape is verbatim.
//
// This is a contract test, not a unit test: it exists so that a change to the
// parser — or a change SAP makes to this endpoint — fails here rather than in
// front of a supplier. Every field name is lowercase, `bedat` is a JSON number
// rather than a string, `waers` is empty on the quotation, and no field names
// the document category at all.
const LIVE_RESPONSE = {
  statusCode: 200,
  status: 'SUCCESS',
  message: 'Quotation fetched successfully',
  data: [
    { ebeln: '4500022503', lifnr: '1120250010', bedat: 20251112, waers: 'INR', ekorg: 'SSDN' },
    { ebeln: '4500022524', lifnr: '1120250010', bedat: 20251117, waers: 'INR', ekorg: 'SSDN' },
    { ebeln: '6000000054', lifnr: '1120250010', bedat: 20260108, waers: '',    ekorg: 'SSDN' },
    { ebeln: '4500022562', lifnr: '1120250010', bedat: 20261201, waers: 'INR', ekorg: 'SSDN' },
  ],
};

const driverFor = (response, capture = {}) => {
  global.fetch = jest.fn(async (url) => {
    capture.url = url;
    return {
      status: 200, statusText: 'OK', ok: true,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => JSON.stringify(response),
    };
  });
  return createS4ODataDriver({
    config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800' },
    secrets: {},
  });
};

afterEach(() => { delete global.fetch; });

describe('ZCL_ME48/vendor — the live contract', () => {
  it('calls the endpoint the way the sandbox expects', async () => {
    const capture = {};
    const driver = driverFor(LIVE_RESPONSE, capture);

    await driver.vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } });

    expect(capture.url).toBe('http://103.206.131.27:8081/ZCL_ME48/vendor?sap-client=800&LIFNR=1120250010');
  });

  it('parses the live payload into the shape the tab renders', async () => {
    const driver = driverFor(LIVE_RESPONSE);

    const { data } = await driver.vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } });

    expect(data.documents).toEqual([
      { documentNumber: '4500022503', documentType: 'Purchase Order', date: '20251112', currency: 'INR', purchasingOrg: 'SSDN' },
      { documentNumber: '4500022524', documentType: 'Purchase Order', date: '20251117', currency: 'INR', purchasingOrg: 'SSDN' },
      // The one 6-series document in the sandbox set: SAP names no category,
      // so the number range is the only thing that distinguishes a quotation.
      { documentNumber: '6000000054', documentType: 'Quotation', date: '20260108', currency: null, purchasingOrg: 'SSDN' },
      { documentNumber: '4500022562', documentType: 'Purchase Order', date: '20261201', currency: 'INR', purchasingOrg: 'SSDN' },
    ]);
  });

  it('never calls SAP without a vendor code — an empty LIFNR dumps the whole client', async () => {
    const capture = {};
    const driver = driverFor(LIVE_RESPONSE, capture);

    const { data } = await driver.vendorQuotationDisplay({ vendor: { sapVendorCode: '  ' } });

    expect(data.documents).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('drops any row belonging to another supplier, whatever SAP returns', async () => {
    const driver = driverFor({
      ...LIVE_RESPONSE,
      data: [...LIVE_RESPONSE.data, { ebeln: '4500099999', lifnr: '9999999999', bedat: 20260101, waers: 'INR', ekorg: 'SSDN' }],
    });

    const { data } = await driver.vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } });

    expect(data.documents.map((d) => d.documentNumber)).not.toContain('4500099999');
    expect(data.documents).toHaveLength(4);
  });

  it('treats a non-array payload as a failure rather than an empty ledger', async () => {
    const driver = driverFor({ statusCode: 500, status: 'ERROR', message: 'boom' });

    await expect(driver.vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } }))
      .rejects.toThrow(/quotation display/i);
  });
});

// The live ZME43/ME43 response, captured from
//   GET /ZME43/ME43?sap-client=800&LIFNR=1120250081
//
// Confirmed live 2026-09-24: this replaced an earlier header-only shape
// (ebeln/lifnr/bedat/waers/ekorg, no items — the same envelope ZCL_ME48/vendor
// still uses, see LIVE_RESPONSE above) with one that embeds each RFQ's own
// line items, `quantity` included — and, unlike zpo_grn/Detail's
// ORDERED_QUANTITY (a goods-received field, always 0 for an RFQ), this
// `quantity` is the real one a supplier is being asked to quote against.
const LIVE_ME43 = {
  statusCode: 200,
  status: 'SUCCESS',
  message: 'Quotation fetched successfully',
  data: [
    {
      quotationNumber: '6000000072', vendorCode: '1120250081', quotationDate: 20260923, currency: '', purchasingOrg: 'SSDN',
      items: [
        { quotationNumber: '6000000072', itemNumber: 10, materialCode: '000000000000000032', materialDesc: 'NEW MATERIAL SAGE TESTING', quantity: 10, unitOfMeasure: 'KG', netPrice: 0, priceUnit: 1, plant: 'SSDN', materialGroup: '0001' },
      ],
    },
    {
      quotationNumber: '6000000073', vendorCode: '1120250081', quotationDate: 20260923, currency: '', purchasingOrg: 'SSDN',
      items: [
        { quotationNumber: '6000000073', itemNumber: 10, materialCode: '000000000000000032', materialDesc: 'NEW MATERIAL SAGE TESTING', quantity: 10, unitOfMeasure: 'KG', netPrice: 0, priceUnit: 1, plant: 'SSDN', materialGroup: '0001' },
        { quotationNumber: '6000000073', itemNumber: 20, materialCode: '000000000000000033', materialDesc: 'NEW MAT TESTING SERILISED PROCREMENT', quantity: 5, unitOfMeasure: 'PC', netPrice: 0, priceUnit: 1, plant: 'SSDN', materialGroup: '0001' },
      ],
    },
    {
      quotationNumber: '6000000074', vendorCode: '1120250081', quotationDate: 20260923, currency: '', purchasingOrg: 'SSDN',
      items: [
        { quotationNumber: '6000000074', itemNumber: 10, materialCode: '000000000000000032', materialDesc: 'NEW MATERIAL SAGE TESTING', quantity: 10, unitOfMeasure: 'KG', netPrice: 0, priceUnit: 1, plant: 'SSDN', materialGroup: '0001' },
        { quotationNumber: '6000000074', itemNumber: 20, materialCode: '000000000000000033', materialDesc: 'NEW MAT TESTING SERILISED PROCREMENT', quantity: 5, unitOfMeasure: 'PC', netPrice: 0, priceUnit: 1, plant: 'SSDN', materialGroup: '0001' },
        { quotationNumber: '6000000074', itemNumber: 30, materialCode: '000000000000000034', materialDesc: 'NEW MATERIAL SAGE TESTING 2', quantity: 10, unitOfMeasure: 'KG', netPrice: 0, priceUnit: 1, plant: 'SSDN', materialGroup: '0001' },
      ],
    },
  ],
};

describe('ZME43/ME43 — the live contract', () => {
  it('calls the endpoint the way the sandbox expects', async () => {
    const capture = {};
    const driver = driverFor(LIVE_ME43, capture);

    await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250081' } });

    expect(capture.url).toBe('http://103.206.131.27:8081/ZME43/ME43?sap-client=800&LIFNR=1120250081');
  });

  it('parses the live payload into the shape the panel renders, items included', async () => {
    const driver = driverFor(LIVE_ME43);

    const { data } = await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250081' } });

    expect(data.documents).toEqual([
      {
        sapRfqNumber: '6000000072', date: '20260923', currency: null, purchasingOrg: 'SSDN',
        items: [{ line: 10, materialCode: '000000000000000032', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, uom: 'KG', targetPrice: null, plant: 'SSDN' }],
      },
      {
        sapRfqNumber: '6000000073', date: '20260923', currency: null, purchasingOrg: 'SSDN',
        items: [
          { line: 10, materialCode: '000000000000000032', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, uom: 'KG', targetPrice: null, plant: 'SSDN' },
          { line: 20, materialCode: '000000000000000033', description: 'NEW MAT TESTING SERILISED PROCREMENT', quantity: 5, uom: 'PC', targetPrice: null, plant: 'SSDN' },
        ],
      },
      {
        sapRfqNumber: '6000000074', date: '20260923', currency: null, purchasingOrg: 'SSDN',
        items: [
          { line: 10, materialCode: '000000000000000032', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, uom: 'KG', targetPrice: null, plant: 'SSDN' },
          { line: 20, materialCode: '000000000000000033', description: 'NEW MAT TESTING SERILISED PROCREMENT', quantity: 5, uom: 'PC', targetPrice: null, plant: 'SSDN' },
          { line: 30, materialCode: '000000000000000034', description: 'NEW MATERIAL SAGE TESTING 2', quantity: 10, uom: 'KG', targetPrice: null, plant: 'SSDN' },
        ],
      },
    ]);
  });

  it('emits `date` as a string, matching the ME48 read', async () => {
    // quotationDate is a JSON *number*. Both reads must agree on the type, or
    // a caller that sorts one and formats the other breaks on whichever it
    // met second.
    const rfq = await driverFor(LIVE_ME43).vendorRfqDisplay({ vendor: { sapVendorCode: '1120250081' } });
    const me48 = await driverFor(LIVE_RESPONSE).vendorQuotationDisplay({ vendor: { sapVendorCode: '1120250010' } });

    expect(typeof rfq.data.documents[0].date).toBe('string');
    expect(typeof me48.data.documents[0].date).toBe('string');
  });

  it('never calls SAP without a vendor code, whitespace included', async () => {
    const driver = driverFor(LIVE_ME43);

    const { data } = await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '  ' } });

    expect(data.documents).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('drops any row belonging to another supplier', async () => {
    const driver = driverFor({
      ...LIVE_ME43,
      data: [...LIVE_ME43.data, { quotationNumber: '6000009999', vendorCode: '9999999999', quotationDate: 20260101, currency: 'INR', purchasingOrg: 'SSDN', items: [] }],
    });

    const { data } = await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250081' } });

    expect(data.documents.map((d) => d.sapRfqNumber)).not.toContain('6000009999');
    expect(data.documents).toHaveLength(3);
  });

  it('reports a target price only when SAP has quoted a real one, never a bare 0', async () => {
    const driver = driverFor({
      ...LIVE_ME43,
      data: [{
        quotationNumber: '6000000099', vendorCode: '1120250081', quotationDate: 20260923, currency: 'INR', purchasingOrg: 'SSDN',
        items: [
          { quotationNumber: '6000000099', itemNumber: 10, materialCode: 'MAT-1', materialDesc: 'Priced line', quantity: 5, unitOfMeasure: 'EA', netPrice: 125.5, priceUnit: 1, plant: 'SSDN' },
          { quotationNumber: '6000000099', itemNumber: 20, materialCode: 'MAT-2', materialDesc: 'Unpriced line', quantity: 5, unitOfMeasure: 'EA', netPrice: 0, priceUnit: 1, plant: 'SSDN' },
        ],
      }],
    });

    const { data } = await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250081' } });

    expect(data.documents[0].items[0].targetPrice).toBe(125.5);
    expect(data.documents[0].items[1].targetPrice).toBeNull();
  });
});

// The live ZQUOT_NETPR/QUOT_UPDPR response, captured from
//   POST /ZQUOT_NETPR/QUOT_UPDPR?sap-client=800
//   { "rfq_number": "6000000062", "items": [{ "item": "10", "net_price": "1400" }, { "item": "20", "net_price": "3000" }] }
//
// Unlike ME43/ME48 this is a write, not a read, and it is the one write this
// driver still performs against a document number the portal did not issue —
// see the note on quotationUpdatePrice in sap/drivers/s4odata.driver.js.
const LIVE_QUOT_UPDPR_RESPONSE = { STATUS: 'S', MESSAGE: 'Quotation updated successfully', RFQ_NUMBER: '6000000062' };

const driverForPost = (response, capture = {}) => {
  global.fetch = jest.fn(async (url, options) => {
    capture.url = url;
    capture.body = options?.body ? JSON.parse(options.body) : null;
    capture.method = options?.method;
    return {
      status: 200, statusText: 'OK', ok: true,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => JSON.stringify(response),
    };
  });
  return createS4ODataDriver({
    config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800' },
    secrets: {},
  });
};

describe('ZQUOT_NETPR/QUOT_UPDPR — the live contract (ME47 price update)', () => {
  it('calls the endpoint the way the sandbox expects: no LIFNR, sap-client only', async () => {
    const capture = {};
    const driver = driverForPost(LIVE_QUOT_UPDPR_RESPONSE, capture);

    await driver.quotationUpdatePrice({
      vendor: { vendorId: 'VND-1' },
      sapRfqNumber: '6000000062',
      items: [{ item: 10, netPrice: 1400 }, { item: 20, netPrice: 3000 }],
    });

    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('http://103.206.131.27:8081/ZQUOT_NETPR/QUOT_UPDPR?sap-client=800');
  });

  it('sends the exact body shape the sandbox expects: snake_case, string item and net_price', async () => {
    const capture = {};
    const driver = driverForPost(LIVE_QUOT_UPDPR_RESPONSE, capture);

    await driver.quotationUpdatePrice({
      vendor: { vendorId: 'VND-1' },
      sapRfqNumber: '6000000062',
      items: [{ item: 10, netPrice: 1400 }, { item: 20, netPrice: 3000 }],
    });

    expect(capture.body).toEqual({
      rfq_number: '6000000062',
      items: [
        { item: '10', net_price: '1400' },
        { item: '20', net_price: '3000' },
      ],
    });
  });

  it('parses a successful response and echoes the RFQ number back', async () => {
    const driver = driverForPost(LIVE_QUOT_UPDPR_RESPONSE);

    const { data } = await driver.quotationUpdatePrice({
      vendor: { vendorId: 'VND-1' }, sapRfqNumber: '6000000062', items: [{ item: 10, netPrice: 1400 }],
    });

    expect(data).toEqual({ status: 'S', message: 'Quotation updated successfully', sapRfqNumber: '6000000062' });
  });

  it('treats STATUS "E" as a failure even though SAP answers HTTP 200', async () => {
    // The sandbox answers 200 with STATUS 'E' on a bad item number — checking
    // response.ok alone would let a rejected price update through silently.
    const driver = driverForPost({ STATUS: 'E', MESSAGE: 'Item 99 not found on RFQ', RFQ_NUMBER: '6000000062' });

    await expect(driver.quotationUpdatePrice({
      vendor: { vendorId: 'VND-1' }, sapRfqNumber: '6000000062', items: [{ item: 99, netPrice: 100 }],
    })).rejects.toThrow(/Item 99 not found/);
  });
});

// The live /zinv_milestone/plan response, captured from
//   GET /zinv_milestone/plan?sap-client=800  { "inv_planno": "0000001255" }
//
// This is a "GET with a JSON body" endpoint like zpo_grn_vendor/Detail and
// zmiro_display/MIRO — fetch refuses a body on GET, so the driver goes around
// it with Node's http module directly (getWithBody). That means these tests
// have to stub `http.request` itself rather than `global.fetch`.
const LIVE_MILESTONE_PLAN = {
  INV_PLANNO: '0000001255',
  ITEM: [
    { BILLING_ITEM: '000001', INV_DATE: '20260901', DATE_DESC: '0003', DESC: 'Contract Signed', INV_PERCENTAGE: '30.00 ', INV_VALUE: '3600.00 ', CURRENCY: 'USD', BILLLING_BLOCK: '99', BILLING_RULE: '1', BILLING_STATUS: 'A', DATE_CATEGORY: 'T1' },
    { BILLING_ITEM: '000002', INV_DATE: '20261001', DATE_DESC: '0004', DESC: 'Engineering/Design', INV_PERCENTAGE: '20.00 ', INV_VALUE: '2400.00 ', CURRENCY: 'USD', BILLLING_BLOCK: '99', BILLING_RULE: '1', BILLING_STATUS: 'A', DATE_CATEGORY: 'T1' },
    { BILLING_ITEM: '000003', INV_DATE: '20261101', DATE_DESC: '0005', DESC: 'Assembly', INV_PERCENTAGE: '30.00 ', INV_VALUE: '3600.00 ', CURRENCY: 'USD', BILLLING_BLOCK: '99', BILLING_RULE: '1', BILLING_STATUS: 'A', DATE_CATEGORY: 'T1' },
    { BILLING_ITEM: '000004', INV_DATE: '20261201', DATE_DESC: '0006', DESC: 'Test run', INV_PERCENTAGE: '20.00 ', INV_VALUE: '2400.00 ', CURRENCY: 'USD', BILLLING_BLOCK: '99', BILLING_RULE: '1', BILLING_STATUS: 'A', DATE_CATEGORY: 'T1' },
  ],
};

/**
 * Stubs Node's `http.request` for the duration of one test — the transport
 * `getWithBody` uses for a GET-with-a-JSON-body call. Captures the URL, the
 * request body it was sent, and answers with `responseBody` (already a JSON
 * string) at `status`.
 */
const mockHttpRequest = (responseBody, { status = 200, statusText = 'OK' } = {}) => {
  const http = require('http');
  const capture = {};
  const original = http.request;

  http.request = (url, options, callback) => {
    capture.url = String(url);
    capture.method = options?.method;
    capture.headers = options?.headers;
    const chunks = [];
    const req = {
      write: (chunk) => { chunks.push(chunk); },
      end: () => {
        capture.body = chunks.length ? JSON.parse(chunks.join('')) : undefined;
        callback({
          statusCode: status,
          statusMessage: statusText,
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

  return { capture, restore: () => { http.request = original; } };
};

describe('zinv_milestone/plan — the live contract (invoicing plan display)', () => {
  const driverFor = () => createS4ODataDriver({
    config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800' },
    secrets: {},
  });

  // The minimum a PO needs for this call: one line item that already knows
  // which SAP invoicing plan it belongs to. Nothing about the plan's type is
  // assumed — that's the point of the test below.
  const poWithPlannedItem = (planNumber = '0000001255', line = 10) => ({
    id: 'PO-2026-0081',
    sapPoNumber: '4500012345',
    currency: 'INR',
    items: [{ line, materialCode: 'MAT-1', description: 'Turbine assembly', invoicePlan: { enabled: true, planNumber } }],
  });

  it('calls the endpoint the way the sandbox expects: GET-with-body, zero-padded plan number', async () => {
    const { capture, restore } = mockHttpRequest(JSON.stringify(LIVE_MILESTONE_PLAN));
    try {
      await driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem() });
    } finally { restore(); }

    expect(capture.method).toBe('GET');
    expect(capture.url).toBe('http://103.206.131.27:8081/zinv_milestone/plan?sap-client=800');
    expect(capture.body).toEqual({ inv_planno: '0000001255' });
  });

  it('zero-pads a plan number the portal stored unpadded', async () => {
    const { capture, restore } = mockHttpRequest(JSON.stringify(LIVE_MILESTONE_PLAN));
    try {
      await driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem('1255') });
    } finally { restore(); }

    expect(capture.body).toEqual({ inv_planno: '0000001255' });
  });

  it('parses the live payload into the shape the invoicing-plan panel renders', async () => {
    const { restore } = mockHttpRequest(JSON.stringify(LIVE_MILESTONE_PLAN));
    let result;
    try {
      result = await driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem('0000001255', 10) });
    } finally { restore(); }

    // The response never says which PO line this is, or what type of plan it
    // is — both come from the caller's own context, not from SAP.
    expect(result.data.plans).toEqual([{
      line: 10,
      planNumber: '0000001255',
      type: null,
      frequency: null,
      invoicingRule: null,
      periodicAmount: null,
      currency: 'USD',
      startDate: '2026-09-01',
      endDate: '2026-12-01',
      reference: null,
      lines: [
        { lineNumber: 1, description: 'Contract Signed', settlementDate: '2026-09-01', billingDate: '2026-09-01', percentage: 30, amount: 3600, status: 'Open', blocked: false },
        { lineNumber: 2, description: 'Engineering/Design', settlementDate: '2026-10-01', billingDate: '2026-10-01', percentage: 20, amount: 2400, status: 'Open', blocked: false },
        { lineNumber: 3, description: 'Assembly', settlementDate: '2026-11-01', billingDate: '2026-11-01', percentage: 30, amount: 3600, status: 'Open', blocked: false },
        { lineNumber: 4, description: 'Test run', settlementDate: '2026-12-01', billingDate: '2026-12-01', percentage: 20, amount: 2400, status: 'Open', blocked: false },
      ],
    }]);
  });

  it('treats a BILLING_STATUS of B or C as invoiced, matching FKSAF', async () => {
    const payload = {
      ...LIVE_MILESTONE_PLAN,
      ITEM: LIVE_MILESTONE_PLAN.ITEM.map((row, i) => (i === 0 ? { ...row, BILLING_STATUS: 'C' } : row)),
    };
    const { restore } = mockHttpRequest(JSON.stringify(payload));
    let result;
    try {
      result = await driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem() });
    } finally { restore(); }

    expect(result.data.plans[0].lines[0].status).toBe('Invoiced');
    expect(result.data.plans[0].lines[1].status).toBe('Open');
  });

  it('reads an actual billing block code as blocked, unlike the sandbox\'s "99"', async () => {
    // '99' is this sandbox's own default-when-unset (see the note in
    // s4odata.driver.js) — every date in the sample sample carries it and none
    // of them are meant to read as blocked. A real block code must still work.
    const payload = {
      ...LIVE_MILESTONE_PLAN,
      ITEM: LIVE_MILESTONE_PLAN.ITEM.map((row, i) => (i === 1 ? { ...row, BILLLING_BLOCK: '01' } : row)),
    };
    const { restore } = mockHttpRequest(JSON.stringify(payload));
    let result;
    try {
      result = await driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem() });
    } finally { restore(); }

    expect(result.data.plans[0].lines[0].blocked).toBe(false);
    expect(result.data.plans[0].lines[1].blocked).toBe(true);
  });

  it('reads a blank or "00" block code as not blocked', async () => {
    const payload = {
      ...LIVE_MILESTONE_PLAN,
      ITEM: LIVE_MILESTONE_PLAN.ITEM.map((row, i) => (i === 2 ? { ...row, BILLLING_BLOCK: '' } : i === 3 ? { ...row, BILLLING_BLOCK: '00' } : row)),
    };
    const { restore } = mockHttpRequest(JSON.stringify(payload));
    let result;
    try {
      result = await driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem() });
    } finally { restore(); }

    expect(result.data.plans[0].lines[2].blocked).toBe(false);
    expect(result.data.plans[0].lines[3].blocked).toBe(false);
  });

  it('never calls SAP for a PO with no line carrying a plan number', async () => {
    const { capture, restore } = mockHttpRequest(JSON.stringify(LIVE_MILESTONE_PLAN));
    let result;
    try {
      result = await driverFor().poInvoicePlanDisplay({
        po: { id: 'PO-1', sapPoNumber: '4500000001', items: [{ line: 10, invoicePlan: { enabled: false } }] },
      });
    } finally { restore(); }

    expect(capture.url).toBeUndefined();
    expect(result.data).toEqual({ poNumber: '4500000001', plans: [] });
  });

  it('fans out one call per planned line item, keeping each on its own line number', async () => {
    const calls = [];
    const http = require('http');
    const original = http.request;
    http.request = (url, options, callback) => {
      const bodyChunks = [];
      calls.push(String(url));
      return {
        write: (chunk) => bodyChunks.push(chunk),
        end: () => {
          const body = JSON.parse(bodyChunks.join(''));
          const planno = body.inv_planno;
          callback({
            statusCode: 200,
            statusMessage: 'OK',
            on: (event, handler) => {
              if (event === 'data') handler(Buffer.from(JSON.stringify({ ...LIVE_MILESTONE_PLAN, INV_PLANNO: planno })));
              if (event === 'end') handler();
            },
          });
        },
        on: () => {},
        destroy: () => {},
      };
    };

    let result;
    try {
      result = await driverFor().poInvoicePlanDisplay({
        po: {
          id: 'PO-2026-0090',
          sapPoNumber: '4500099999',
          items: [
            { line: 10, invoicePlan: { enabled: true, planNumber: '0000001255' } },
            { line: 20, invoicePlan: { enabled: true, planNumber: '0000001260' } },
          ],
        },
      });
    } finally { http.request = original; }

    expect(calls).toHaveLength(2);
    expect(result.data.plans.map((p) => ({ line: p.line, planNumber: p.planNumber }))).toEqual([
      { line: 10, planNumber: '0000001255' },
      { line: 20, planNumber: '0000001260' },
    ]);
  });

  it('treats a non-object payload (or one missing ITEM) as a failure rather than an empty plan', async () => {
    const { restore } = mockHttpRequest(JSON.stringify({ STATUS: 'E', MESSAGE: 'Plan not found' }));
    try {
      await expect(driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem() })).rejects.toThrow(/invoicing plan display/i);
    } finally { restore(); }
  });

  it('treats an HTTP failure status as a failure', async () => {
    const { restore } = mockHttpRequest(JSON.stringify(LIVE_MILESTONE_PLAN), { status: 500, statusText: 'Internal Server Error' });
    try {
      await expect(driverFor().poInvoicePlanDisplay({ po: poWithPlannedItem() })).rejects.toThrow(/invoicing plan display/i);
    } finally { restore(); }
  });
});

// The live /zpo_grn/Detail response, captured from
//   GET /zpo_grn/Detail?sap-client=800  { "PO": "4500022789" }
//
// The single-order sibling of zpo_grn_vendor/Detail: one object rather than an
// array, keyed on the PO number rather than the vendor code, same field names —
// and, the reason the driver reads it at all, an INV_PLANNO per line item.
// Trimmed here to the header fields the assertions touch plus the whole of the
// one line item, which is verbatim.
const LIVE_PO_DETAIL = {
  REGION: 'Germany',
  PO_NUMBER: '4500022789',
  PO_DATE: '01.09.2026',
  VENDOR_ID: '0000300000',
  VENDOR_NAME: 'Edwin Dealer',
  CURRENCY: 'USD',
  NET_AMOUNT: '0.00 ',
  GROSS_AMOUNT: '12000.00 ',
  COM_CODE: '1000',
  PO_LINE_ITEMS: [
    {
      PO_NUMBER: '4500022789',
      ITEM_NUMBER: '00010',
      TYPE: 'NB',
      MATERIAL_CODE: '',
      DESCRIPTION: 'Annual Maintenance Contract – Server Roo',
      ORDERED_QUANTITY: '1.000 ',
      GR_EXPECTED: 'Open',
      RECEIVED_QUANTITY: '1.000 ',
      INVOICED_QUANTITY: '1.000 ',
      UOM: 'LE',
      UNIT_PRICE: '12000.00 ',
      NET_AMOUNT: '12000.00 ',
      TAX_CODE: 'V0',
      GROSS_AMOUNT: '12000.00 ',
      PLANT: '1000',
      INV_PLANNO: '0000001255',
      GRN: [],
    },
  ],
};

describe('zpo_grn/Detail — the live contract (invoicing plan number discovery)', () => {
  const driverFor = () => createS4ODataDriver({
    config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800' },
    secrets: {},
  });

  it('calls the endpoint the way the sandbox expects: GET-with-body, uppercase PO key', async () => {
    const { capture, restore } = mockHttpRequest(JSON.stringify(LIVE_PO_DETAIL));
    try {
      await driverFor().poInvoicePlanNumbers({ po: { id: 'PO-1', sapPoNumber: '4500022789' } });
    } finally { restore(); }

    expect(capture.method).toBe('GET');
    expect(capture.url).toBe('http://103.206.131.27:8081/zpo_grn/Detail?sap-client=800');
    // Uppercase "PO" — zinv_milestone/plan takes a lowercase "inv_planno" in the
    // same sandbox, so the casing is per-endpoint and not a house style.
    expect(capture.body).toEqual({ PO: '4500022789' });
  });

  it('reports the plan number SAP holds against each line, as a portal line number', async () => {
    const { restore } = mockHttpRequest(JSON.stringify(LIVE_PO_DETAIL));
    let result;
    try {
      result = await driverFor().poInvoicePlanNumbers({ po: { id: 'PO-1', sapPoNumber: '4500022789' } });
    } finally { restore(); }

    expect(result.data).toEqual({
      poNumber: '4500022789',
      // "00010" is SAP's spelling of line 10. This fixture line carries no
      // ACC_ASSIGNMNT_CAT at all, which is an ordinary material line.
      lines: [{ line: 10, planNumber: '0000001255', accountAssignmentCategory: null }],
    });
  });

  // The other half of what this endpoint uniquely answers. zpo_grn_vendor/Detail
  // — the vendor-wide ledger the sweep reads — returns neither INV_PLANNO nor
  // ACC_ASSIGNMNT_CAT on its lines, so an asset or service order is only
  // identifiable through this per-order read.
  it('reports the account assignment category that marks an asset or service line', async () => {
    const payload = {
      ...LIVE_PO_DETAIL,
      PO_LINE_ITEMS: [
        { ...LIVE_PO_DETAIL.PO_LINE_ITEMS[0], INV_PLANNO: '', ACC_ASSIGNMNT_CAT: 'A' },
        { ...LIVE_PO_DETAIL.PO_LINE_ITEMS[0], ITEM_NUMBER: '00020', INV_PLANNO: '', ACC_ASSIGNMNT_CAT: 'D' },
        { ...LIVE_PO_DETAIL.PO_LINE_ITEMS[0], ITEM_NUMBER: '00030', INV_PLANNO: '', ACC_ASSIGNMNT_CAT: '' },
      ],
    };
    const { restore } = mockHttpRequest(JSON.stringify(payload));
    let result;
    try {
      result = await driverFor().poInvoicePlanNumbers({ po: { id: 'PO-1', sapPoNumber: '4500022789' } });
    } finally { restore(); }

    expect(result.data.lines).toEqual([
      { line: 10, planNumber: null, accountAssignmentCategory: 'A' },
      { line: 20, planNumber: null, accountAssignmentCategory: 'D' },
      // Blank is the ordinary material line, and must not become the string "".
      { line: 30, planNumber: null, accountAssignmentCategory: null },
    ]);
  });

  it('reports a line with no invoicing plan as planNumber null, not as a blank string', async () => {
    // Most order lines have no invoicing plan; a blank INV_PLANNO is the normal
    // case, not a missing field, and must not become the string "". The line
    // itself is still reported — it carries the account assignment category,
    // which is most interesting precisely where there is no plan.
    const payload = {
      ...LIVE_PO_DETAIL,
      PO_LINE_ITEMS: [
        LIVE_PO_DETAIL.PO_LINE_ITEMS[0],
        { ...LIVE_PO_DETAIL.PO_LINE_ITEMS[0], ITEM_NUMBER: '00020', INV_PLANNO: '' },
        { ...LIVE_PO_DETAIL.PO_LINE_ITEMS[0], ITEM_NUMBER: '00030', INV_PLANNO: undefined },
      ],
    };
    const { restore } = mockHttpRequest(JSON.stringify(payload));
    let result;
    try {
      result = await driverFor().poInvoicePlanNumbers({ po: { id: 'PO-1', sapPoNumber: '4500022789' } });
    } finally { restore(); }

    expect(result.data.lines).toEqual([
      { line: 10, planNumber: '0000001255', accountAssignmentCategory: null },
      { line: 20, planNumber: null, accountAssignmentCategory: null },
      { line: 30, planNumber: null, accountAssignmentCategory: null },
    ]);
  });

  it('never calls SAP for an order that has no SAP number yet', async () => {
    // An RFQ awarded in the portal has sapPoNumber null until SAP's own order is
    // correlated (§5.6) — there is nothing to ask about.
    const { capture, restore } = mockHttpRequest(JSON.stringify(LIVE_PO_DETAIL));
    let result;
    try {
      result = await driverFor().poInvoicePlanNumbers({ po: { id: 'PO-1', sapPoNumber: null } });
    } finally { restore(); }

    expect(capture.url).toBeUndefined();
    expect(result.data).toEqual({ poNumber: null, lines: [] });
  });

  it('treats a payload with no PO_LINE_ITEMS as a failure rather than an order with no plans', async () => {
    const { restore } = mockHttpRequest(JSON.stringify({ TYPE: 'E', MESSAGE: 'PO not found' }));
    try {
      await expect(driverFor().poInvoicePlanNumbers({ po: { id: 'PO-1', sapPoNumber: '4500022789' } }))
        .rejects.toThrow(/PO detail/i);
    } finally { restore(); }
  });
});

// The live /zinv_plan/update response, captured from
//   POST /zinv_plan/update?sap-client=800  { "DATA": [ … ] }
//
// A bulk write: DATA is a flat list of FPLT dates, each repeating its PO number
// and item, and the response reports an envelope TYPE plus a per-PO RESULTS row.
const LIVE_INV_PLAN_UPDATE_RESPONSE = {
  TYPE: 'S',
  MESSAGE: 'Invoice Plan uploaded successfully',
  RESULTS: [{ TYPE: 'S', MESSAGE: 'PO 4500022802: Invoice plan updated successfully', PO: '4500022802' }],
};

describe('zinv_plan/update — the live contract (invoicing plan update)', () => {
  const PO = {
    id: 'PO-2026-0081',
    sapPoNumber: '4500022802',
    vendorId: 'VND-40013',
    currency: 'INR',
  };
  const ITEM = { line: 10, materialCode: 'MAT-1', description: 'Turbine assembly' };
  const PLAN = {
    enabled: true,
    type: 'Partial',
    currency: 'INR',
    lines: [
      { lineNumber: 1, description: 'Contract Signed', settlementDate: '2026-09-16', percentage: 25, amount: 25000 },
      { lineNumber: 2, description: 'Engineering/Design', settlementDate: '2026-09-17', percentage: 25, amount: 25000 },
      { lineNumber: 3, description: 'Assembly', settlementDate: '2026-09-18', percentage: 25, amount: 25000 },
      { lineNumber: 4, description: 'Test run', settlementDate: '2026-09-19', percentage: 25, amount: 25000 },
    ],
  };

  // The update POSTs through fetch and then reads the assigned plan number back
  // through zpo_grn/Detail, which is a GET-with-body on http.request — so a test
  // of this method has to stub both transports.
  const stubBoth = (response = LIVE_INV_PLAN_UPDATE_RESPONSE, { status = 200, planNumber = '0000001255' } = {}) => {
    const capture = {};
    global.fetch = jest.fn(async (url, options) => {
      capture.url = url;
      capture.method = options?.method;
      capture.body = options?.body ? JSON.parse(options.body) : null;
      return {
        status, statusText: status === 200 ? 'OK' : 'Error', ok: status >= 200 && status < 300,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => JSON.stringify(response),
      };
    });
    const detail = mockHttpRequest(JSON.stringify({
      ...LIVE_PO_DETAIL,
      PO_NUMBER: PO.sapPoNumber,
      PO_LINE_ITEMS: [{ ...LIVE_PO_DETAIL.PO_LINE_ITEMS[0], INV_PLANNO: planNumber }],
    }));
    return { capture, restore: detail.restore };
  };

  const driverFor = (config = {}) => createS4ODataDriver({
    config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800', ...config },
    secrets: {},
  });

  it('posts to the endpoint the sandbox actually exposes', async () => {
    const { capture, restore } = stubBoth();
    try {
      await driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN });
    } finally { restore(); }

    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('http://103.206.131.27:8081/zinv_plan/update?sap-client=800');
  });

  it('sends one flat DATA row per invoicing date, in the sandbox\'s own field spelling', async () => {
    const { capture, restore } = stubBoth();
    try {
      await driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN });
    } finally { restore(); }

    expect(capture.body.DATA).toHaveLength(4);
    expect(capture.body.DATA[0]).toEqual({
      PO_NUMBER: '4500022802',
      PO_ITEM: '00010',
      IV_PLAN_ITEM: '000001',
      CATEGORY: 'B',
      INV_PLAN_TYPE: 'M2',
      START_DATE: '09/16/2026',
      DATE_CATG: 'T1',
      DATE_DESC: '0003',
      SETT_DATE_FROM: '09/16/2026',
      BILL_RULE: '1',
      INVOICE_PERCENTAGE: '25.00',
      CURRENCY: 'INR',
      BILL_VALUE: '25000.00',
      BILLING_BLOCK: '99',
      BILLING_STATUS: '',
      BILL_DATE: '09/16/2026',
    });
  });

  it('sends dates as MM/DD/YYYY, not the YYYYMMDD the display endpoint returns', async () => {
    // The two halves of the same feature disagree on date format. Getting this
    // backwards is the obvious mistake, so it is pinned on its own.
    const { capture, restore } = stubBoth();
    try {
      await driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN });
    } finally { restore(); }

    expect(capture.body.DATA.map((row) => row.START_DATE))
      .toEqual(['09/16/2026', '09/17/2026', '09/18/2026', '09/19/2026']);
  });

  it('reads the assigned FPLA plan number back off the order, since the update never reports one', async () => {
    const { restore } = stubBoth(LIVE_INV_PLAN_UPDATE_RESPONSE, { planNumber: '0000001300' });
    let result;
    try {
      result = await driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN });
    } finally { restore(); }

    expect(result.data).toEqual({ planNumber: '0000001300', line: 10, dates: 4 });
  });

  it('keeps a successful push when the plan-number read back fails', async () => {
    // The plan IS in SAP once the POST succeeds. Failing the whole call over the
    // follow-up read would tell the buyer a plan SAP accepted was rejected.
    global.fetch = jest.fn(async () => ({
      status: 200, statusText: 'OK', ok: true,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => JSON.stringify(LIVE_INV_PLAN_UPDATE_RESPONSE),
    }));
    const { restore } = mockHttpRequest('nope', { status: 500, statusText: 'Internal Server Error' });
    let result;
    try {
      result = await driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN });
    } finally { restore(); }

    expect(result.data.planNumber).toBeNull();
    expect(result.data.dates).toBe(4);
  });

  it('treats a per-PO RESULTS row of E as a failure even when the envelope TYPE is S', async () => {
    // A bulk endpoint can accept the request and reject this order. Checking the
    // envelope alone would record a rejected plan as pushed.
    const { restore } = stubBoth({
      TYPE: 'S',
      MESSAGE: 'Invoice Plan uploaded successfully',
      RESULTS: [{ TYPE: 'E', MESSAGE: 'PO 4500022802: item 00010 has no invoicing plan category', PO: '4500022802' }],
    });
    try {
      await expect(driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN }))
        .rejects.toThrow(/no invoicing plan category/);
    } finally { restore(); }
  });

  it('treats an envelope TYPE of E as a failure even though SAP answers HTTP 200', async () => {
    const { restore } = stubBoth({ TYPE: 'E', MESSAGE: 'Invoice plan upload failed', RESULTS: [] });
    try {
      await expect(driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: PLAN }))
        .rejects.toThrow(/Invoice plan upload failed/);
    } finally { restore(); }
  });

  it('sends the configured block code for a blocked date, and 99 for the rest', async () => {
    const { capture, restore } = stubBoth();
    try {
      await driverFor().poInvoicePlanUpdate({
        po: PO,
        item: ITEM,
        plan: { ...PLAN, lines: PLAN.lines.map((line, i) => (i === 1 ? { ...line, blocked: true } : line)) },
      });
    } finally { restore(); }

    expect(capture.body.DATA.map((row) => row.BILLING_BLOCK)).toEqual(['99', '01', '99', '99']);
  });

  it('refuses a periodic plan until the tenant configures its SAP plan type', async () => {
    // Only the partial/milestone type has been observed live. Pushing a periodic
    // schedule under 'M2' would file it in SAP as something it is not.
    const { restore } = stubBoth();
    try {
      await expect(driverFor().poInvoicePlanUpdate({ po: PO, item: ITEM, plan: { ...PLAN, type: 'Periodic' } }))
        .rejects.toThrow(/invoicePlanTypePeriodic/);
    } finally { restore(); }
  });

  it('pushes a periodic plan once the tenant has configured its type', async () => {
    const { capture, restore } = stubBoth();
    try {
      await driverFor({ invoicePlanTypePeriodic: 'M1' })
        .poInvoicePlanUpdate({ po: PO, item: ITEM, plan: { ...PLAN, type: 'Periodic' } });
    } finally { restore(); }

    expect(capture.body.DATA.every((row) => row.INV_PLAN_TYPE === 'M1')).toBe(true);
  });

  it('refuses an order SAP has not been correlated with yet', async () => {
    const { restore } = stubBoth();
    try {
      await expect(driverFor().poInvoicePlanUpdate({ po: { ...PO, sapPoNumber: null }, item: ITEM, plan: PLAN }))
        .rejects.toThrow(/no SAP order number yet/);
    } finally { restore(); }
  });
});

// The live /zasset_po/create response, captured from
//   POST /zasset_po/create?sap-client=800
//
// The one call in this driver that creates a document in SAP (ADR-0042). Same
// { TYPE, MESSAGE, RESULTS[] } envelope as zinv_plan/update, plus the thing
// that makes it worth making at all: PO_NUMBER, SAP's own order number.
const LIVE_ASSET_PO_RESPONSE = {
  TYPE: 'S',
  MESSAGE: 'Asset PO 4500022807 created successfully',
  PO_NUMBER: '4500022807',
  RESULTS: [{ TYPE: 'S', MESSAGE: 'PO 4500022807 created' }],
};

describe('zasset_po/create — the live contract (asset PO creation)', () => {
  const VENDOR = { vendorId: 'VND-40013', sapVendorCode: '1120250010' };
  const ORDER = {
    companyCode: 'SSDN',
    purchasingOrg: 'SSDN',
    purchasingGroup: 'SDN',
    docType: 'NB',
    paymentTerms: '0001',
    currency: 'INR',
    docDate: '2026-09-16',
  };
  const ITEMS = [{
    description: 'ASSET TESTING',
    plant: 'SSDN',
    storageLocation: 'SSDN',
    materialGroup: '018',
    quantity: 5,
    uom: 'EA',
    unitPrice: 10000,
    priceUnit: 1,
    taxCode: 'V0',
    assetNumber: '000000000701',
    assetSubNumber: '0000',
  }];

  const driverForCreate = (response = LIVE_ASSET_PO_RESPONSE, { status = 200, capture = {} } = {}) => {
    global.fetch = jest.fn(async (url, options) => {
      capture.url = url;
      capture.method = options?.method;
      capture.body = options?.body ? JSON.parse(options.body) : null;
      return {
        status, statusText: status === 200 ? 'OK' : 'Error', ok: status >= 200 && status < 300,
        headers: { get: () => null, getSetCookie: () => [] },
        text: async () => JSON.stringify(response),
      };
    });
    return createS4ODataDriver({
      config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800' },
      secrets: {},
    });
  };

  it('sends the exact payload shape the sandbox accepts', async () => {
    const capture = {};
    await driverForCreate(LIVE_ASSET_PO_RESPONSE, { capture })
      .poAssetCreate({ vendor: VENDOR, order: ORDER, items: ITEMS });

    expect(capture.method).toBe('POST');
    expect(capture.url).toBe('http://103.206.131.27:8081/zasset_po/create?sap-client=800');
    expect(capture.body).toEqual({
      COMPANY_CODE: 'SSDN',
      PURCH_ORG: 'SSDN',
      PURCH_GROUP: 'SDN',
      VENDOR: '1120250010',
      DOC_TYPE: 'NB',
      PAYMENT_TERMS: '0001',
      CURRENCY: 'INR',
      DOC_DATE: '09/16/2026',
      ITEMS: [{
        SHORT_TEXT: 'ASSET TESTING',
        PLANT: 'SSDN',
        STORAGE_LOC: 'SSDN',
        MATL_GROUP: '018',
        QUANTITY: '5.000',
        UNIT: 'EA',
        NET_PRICE: '10000.00',
        PRICE_UNIT: '1',
        TAX_CODE: 'V0',
        ASSET_NUMBER: '000000000701',
        ASSET_SUBNUM: '0000',
      }],
    });
  });

  it('returns the real PO number SAP issued, never one of its own', async () => {
    const { data } = await driverForCreate()
      .poAssetCreate({ vendor: VENDOR, order: ORDER, items: ITEMS });

    expect(data.sapPoNumber).toBe('4500022807');
    expect(data.items).toBe(1);
  });

  it('sends QUANTITY with three decimals, matching SAP MENGE', async () => {
    // sapAmount's two places would truncate a 0.125 quantity to 0.13 — MENGE is
    // Decimal(13,3) here and in SAP (issue #65).
    const capture = {};
    await driverForCreate(LIVE_ASSET_PO_RESPONSE, { capture })
      .poAssetCreate({ vendor: VENDOR, order: ORDER, items: [{ ...ITEMS[0], quantity: 0.125 }] });

    expect(capture.body.ITEMS[0].QUANTITY).toBe('0.125');
  });

  it('passes a non-ISO unit through untouched instead of throwing on it', async () => {
    // encodeForSap('MEINS', …) maps to ISO codes and throws on anything it does
    // not know. This sandbox speaks SAP internal units — "EA" here, "LE" on
    // zpo_grn/Detail — neither of which the registry has. Routing this field
    // through it would make every asset PO a SapFieldError.
    const capture = {};
    await driverForCreate(LIVE_ASSET_PO_RESPONSE, { capture })
      .poAssetCreate({ vendor: VENDOR, order: ORDER, items: [{ ...ITEMS[0], uom: 'LE' }] });

    expect(capture.body.ITEMS[0].UNIT).toBe('LE');
  });

  it('treats a success envelope with no PO_NUMBER as a failure', async () => {
    // The entire point of this call is to come back with SAP's own number.
    // Accepting a blank one would recreate the "local order claiming an SAP
    // document that does not exist" state this endpoint exists to avoid.
    await expect(driverForCreate({ TYPE: 'S', MESSAGE: 'Created', RESULTS: [] })
      .poAssetCreate({ vendor: VENDOR, order: ORDER, items: ITEMS }))
      .rejects.toThrow(/returned no PO_NUMBER/);
  });

  it('treats a RESULTS row of E as a failure even when the envelope TYPE is S', async () => {
    await expect(driverForCreate({
      TYPE: 'S',
      MESSAGE: 'Asset PO created successfully',
      PO_NUMBER: '4500022807',
      RESULTS: [{ TYPE: 'E', MESSAGE: 'Asset 000000000701 does not exist in company code SSDN' }],
    }).poAssetCreate({ vendor: VENDOR, order: ORDER, items: ITEMS }))
      .rejects.toThrow(/Asset 000000000701 does not exist/);
  });

  it('treats an envelope TYPE of E as a failure even though SAP answers HTTP 200', async () => {
    await expect(driverForCreate({ TYPE: 'E', MESSAGE: 'Vendor 1120250010 is blocked', RESULTS: [] })
      .poAssetCreate({ vendor: VENDOR, order: ORDER, items: ITEMS }))
      .rejects.toThrow(/Vendor 1120250010 is blocked/);
  });

  it('refuses to send anything at all when a line has no asset number', async () => {
    // The guard must fire BEFORE the POST — a half-built asset PO reaching SAP
    // is not recoverable from this side.
    const capture = {};
    const driver = driverForCreate(LIVE_ASSET_PO_RESPONSE, { capture });

    await expect(driver.poAssetCreate({
      vendor: VENDOR, order: ORDER, items: [{ ...ITEMS[0], assetNumber: undefined }],
    })).rejects.toThrow(/assetNumber/);

    expect(capture.url).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses a vendor with no SAP vendor master, without calling SAP', async () => {
    const capture = {};
    const driver = driverForCreate(LIVE_ASSET_PO_RESPONSE, { capture });

    await expect(driver.poAssetCreate({
      vendor: { vendorId: 'VND-1' }, order: ORDER, items: ITEMS,
    })).rejects.toThrow(/sapVendorCode/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refuses the empty call the conformance runner makes, rather than TypeError-ing', async () => {
    // poAssetCreate has no conformance fixture on purpose (see fixtures.js) —
    // a run would otherwise consume a real PO number every time. The runner
    // still calls it with {}, so that has to fail with a reason.
    const driver = driverForCreate();
    await expect(driver.poAssetCreate({})).rejects.toThrow(/sapVendorCode is required/);
    await expect(driver.poAssetCreate()).rejects.toThrow(/sapVendorCode is required/);
  });

  it('refuses an order with no organisational scope, without calling SAP', async () => {
    const driver = driverForCreate();
    await expect(driver.poAssetCreate({
      vendor: VENDOR, order: { ...ORDER, purchasingOrg: undefined }, items: ITEMS,
    })).rejects.toThrow(/purchasingOrg/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
