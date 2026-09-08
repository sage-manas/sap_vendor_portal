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
//   GET /ZME43/ME43?sap-client=800&LIFNR=1120250000
//
// Note it is the *same* envelope, the same field names, and even the same
// "Quotation fetched successfully" message as ZCL_ME48/vendor — these are the
// same handler on the SAP side, differing only in which documents they select.
// Everything here is in the 6xxxxxxx RFQ range, which is what ME43 is for.
const LIVE_ME43 = {
  statusCode: 200,
  status: 'SUCCESS',
  message: 'Quotation fetched successfully',
  data: [
    { ebeln: '6000000057', lifnr: '1120250000', bedat: 20260520, waers: 'INR', ekorg: 'SSDN' },
    { ebeln: '6000000059', lifnr: '1120250000', bedat: 20260821, waers: 'INR', ekorg: 'SSDN' },
    { ebeln: '6000000060', lifnr: '1120250000', bedat: 20260821, waers: '',    ekorg: 'SSDN' },
    { ebeln: '6000000062', lifnr: '1120250000', bedat: 20260821, waers: 'INR', ekorg: 'SSDN' },
  ],
};

describe('ZME43/ME43 — the live contract', () => {
  it('calls the endpoint the way the sandbox expects', async () => {
    const capture = {};
    const driver = driverFor(LIVE_ME43, capture);

    await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250000' } });

    expect(capture.url).toBe('http://103.206.131.27:8081/ZME43/ME43?sap-client=800&LIFNR=1120250000');
  });

  it('parses the live payload into the shape the panel renders', async () => {
    const driver = driverFor(LIVE_ME43);

    const { data } = await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250000' } });

    expect(data.documents).toEqual([
      { sapRfqNumber: '6000000057', date: '20260520', currency: 'INR', purchasingOrg: 'SSDN' },
      { sapRfqNumber: '6000000059', date: '20260821', currency: 'INR', purchasingOrg: 'SSDN' },
      { sapRfqNumber: '6000000060', date: '20260821', currency: null, purchasingOrg: 'SSDN' },
      { sapRfqNumber: '6000000062', date: '20260821', currency: 'INR', purchasingOrg: 'SSDN' },
    ]);
  });

  it('emits `date` as a string, matching the ME48 read', async () => {
    // bedat is a JSON *number*. Both reads must agree on the type, or a caller
    // that sorts one and formats the other breaks on whichever it met second.
    const rfq = await driverFor(LIVE_ME43).vendorRfqDisplay({ vendor: { sapVendorCode: '1120250000' } });
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
      data: [...LIVE_ME43.data, { ebeln: '6000009999', lifnr: '9999999999', bedat: 20260101, waers: 'INR', ekorg: 'SSDN' }],
    });

    const { data } = await driver.vendorRfqDisplay({ vendor: { sapVendorCode: '1120250000' } });

    expect(data.documents.map((d) => d.sapRfqNumber)).not.toContain('6000009999');
    expect(data.documents).toHaveLength(4);
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
