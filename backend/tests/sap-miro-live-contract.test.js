// Issue #349. The invoice/payment chain read the live zmiro_display/MIRO and
// zpayment_api/payment payloads wrongly: "20261001" went into `new Date()`
// (Invalid Date, so no SAP invoice could ever be recorded), TAXABLE_AMOUNT was
// read as the subtotal, and REFERENCE — the supplier's own invoice reference —
// was read as the PO number. These are the verbatim live responses, captured
// read-only for vendor 1120250081, so a change SAP makes to either endpoint
// fails here rather than in front of a supplier.
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');
const { parseSapDate, sapDateToIso } = require('../sap/mappings/dates');
const sweepInvoices = require('../jobs/handlers/sweepInvoices');
const { seedClient } = require('./helpers');

//   GET /zmiro_display/MIRO?sap-client=800  { "vendor": "1120250081" }
const LIVE_MIRO = '[{"INV_DOC_NO":"5105609771","FISCAL_YEAR":"2026","DOC_TYPE":"RE","DOC_DATE":"20261001","POST_DATE":"20261001","USERNAME":"SAGEMM","REFERENCE":"TESTING","COM_CODE":"SSDN","VENDOR":"1120250081","CURRENCY":"INR","EXCH_RATE":"1.00000 ","GROSS_AMOUNT":"25000.00 ","TAXABLE_AMOUNT":"0.00 ","TAX_CODE":"V0","PAYMENT_TERM":"","BASELINE_DATE":"20261001","ITEM":[{"MIRO_NO":"5105609771","FISCAL_YEAR":"2026","INVOICE_ITEM":"000001","PO_NO":"4500022838","PO_ITEM":"00010","MATERIAL":"","VALUATION_AREA":"SSDN","COM_CODE":"SSDN","PLANT":"SSDN","AMOUNT":25000.00 ,"DEBIT_CREDIT_IND":"S","TAX_CODE":"V0","QUANTITY":10.000 ,"UNIT":"","COND_TYPE":"","TOT_VALUE":0.00 }]}]';

//   GET /zpayment_api/payment?sap-client=800&belnr=5105609771&gjahr=2026
// Still open on the sandbox; the cleared variants below change only STATUS,
// CLEARING_DOCUMENT and CLEARING_DATE.
const LIVE_PAYMENT = {
  INVOICE_NO: '5105609771', FISCAL_YEAR: 2026, VENDOR_NO: '1120250081', COMPANY_CODE: 'SSDN', SAP_DOC_NO: '5120250265',
  SPECIAL_GL_IND: '', CLEARING_DOCUMENT: '', ASSIGNMENT_NO: '', POSTING_DATE: '', DOCUMENT_DATE: '2026-10-01',
  AMOUNT_LOCAL_CUR: 25000.00, AMOUNT_DOC_CUR: 25000.00, CLEARING_DATE: '', DOCUMENT_TYPE: 'RE', GROSS_AMOUNT: 25000.00,
  TDS_DEDUCTED: 0, NET_DISBURSED: 25000.00, PAYMENT_METHOD: 'C', STATUS: 'OPEN', UTR_REFERENCE: '',
};

// Same http.request stub as tests/sap-vendor-response-cache.test.js: the MIRO
// read is a GET with a body, which goes through Node's http, not fetch.
const stubMiro = (body = LIVE_MIRO) => {
  const http = require('http');
  const original = http.request;
  http.request = (url, options, callback) => ({
    write: () => {},
    end: () => callback({
      statusCode: 200,
      statusMessage: 'OK',
      on: (event, handler) => {
        if (event === 'data') handler(Buffer.from(body));
        if (event === 'end') handler();
      },
    }),
    on: () => {},
    destroy: () => {},
  });
  return () => { http.request = original; };
};

const stubPayment = (row) => {
  global.fetch = jest.fn(async () => ({
    status: 200, statusText: 'OK', ok: true,
    headers: { get: () => null, getSetCookie: () => [] },
    text: async () => JSON.stringify(row),
  }));
};

const CONFIG = { baseUrl: 'http://sandbox', sapClient: '800', companyCode: 'SSDN' };

let restoreHttp;
afterEach(() => {
  if (restoreHttp) restoreHttp();
  restoreHttp = null;
  delete global.fetch;
});

describe('parseSapDate', () => {
  it('reads every spelling the Z endpoints have sent as the same day', () => {
    for (const value of ['20261001', 20261001, '2026-10-01', '01.10.2026']) {
      expect(sapDateToIso(value)).toBe('2026-10-01');
    }
  });

  it('answers null — never today — for an unset or unreadable date', () => {
    for (const value of ['', null, undefined, '00000000', 0, '20261345', 'TESTING']) {
      expect(parseSapDate(value)).toBeNull();
    }
  });
});

describe('zmiro_display/MIRO — the live contract', () => {
  it('maps the live row into dates, a reference, a PO and amounts that mean what they say', async () => {
    restoreHttp = stubMiro();
    const driver = createS4ODataDriver({ config: CONFIG, secrets: {} });

    const { data } = await driver.vendorMiroDisplay({ vendor: { sapVendorCode: '1120250081' } });
    const [document] = data.documents;

    expect(document).toMatchObject({
      miroDoc: '5105609771',
      docDate: '2026-10-01',
      postingDate: '2026-10-01',
      // XBLNR — the supplier's reference, not a PO.
      supplierReference: 'TESTING',
      poNumber: '4500022838',
      grossAmount: 25000,
      netAmount: 25000,
      taxAmount: 0,
    });
  });
});

describe('sweepInvoices against the live MIRO row', () => {
  beforeEach(() => seedClient());

  it('records the invoice SAP posted, dated, numbered and priced as SAP has it', async () => {
    await runWithTenant('CLT-0001', () => prisma.vendor.create({ data: {
      vendorId: 'VND-KAVERI', sapVendorCode: '1120250081', companyName: 'Kaveri Forge & Fittings',
      gstin: '27AAECK4821M1Z6', pan: 'AAECK4821M', email: 'kaveri@example.com',
    } }));
    await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({ data: {
      id: 'PO-2026-0005', vendorId: 'VND-KAVERI', sapPoNumber: '4500022838', sapDocNumber: '4500022838', sapSyncState: 'synced', status: 'Open',
    } }));
    restoreHttp = stubMiro();

    await runWithTenant('CLT-0001', () => sweepInvoices({
      job: { clientId: 'CLT-0001', args: {} },
      adapter: buildTransientAdapter({ clientId: 'CLT-0001', driver: 's4_odata', config: CONFIG, secrets: {} }),
    }));

    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.findFirst({ where: { sapMiroDoc: '5105609771' }, include: { items: true } }));
    expect(invoice).toBeTruthy();
    expect(invoice.poId).toBe('PO-2026-0005');
    expect(invoice.invoiceNumber).toBe('TESTING');
    expect(invoice.invoiceDate.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(invoice.id).toMatch(/^INV-2026-/);
    expect(Number(invoice.subTotal)).toBe(25000);
    expect(Number(invoice.taxAmount)).toBe(0);
    expect(Number(invoice.totalAmount)).toBe(25000);
    expect(invoice.items[0].materialCode).toBe('');
  });

  it('skips a document whose date it cannot read, instead of failing the whole sweep', async () => {
    await runWithTenant('CLT-0001', () => prisma.vendor.create({ data: {
      vendorId: 'VND-KAVERI', sapVendorCode: '1120250081', companyName: 'Kaveri Forge & Fittings',
      gstin: '27AAECK4821M1Z6', pan: 'AAECK4821M', email: 'kaveri@example.com',
    } }));
    await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({ data: {
      id: 'PO-2026-0005', vendorId: 'VND-KAVERI', sapPoNumber: '4500022838', sapDocNumber: '4500022838', sapSyncState: 'synced', status: 'Open',
    } }));
    restoreHttp = stubMiro(LIVE_MIRO.replace('"DOC_DATE":"20261001"', '"DOC_DATE":""'));

    await expect(runWithTenant('CLT-0001', () => sweepInvoices({
      job: { clientId: 'CLT-0001', args: {} },
      adapter: buildTransientAdapter({ clientId: 'CLT-0001', driver: 's4_odata', config: CONFIG, secrets: {} }),
    }))).resolves.toEqual({ done: true });

    const count = await runWithTenant('CLT-0001', () => prisma.invoice.count());
    expect(count).toBe(0);
  });
});

describe('awaitPaymentRun against the live payment detail', () => {
  const invoice = { id: 'INV-1', sapPoNumber: '4500022838', totalAmount: 25000, invoiceDate: '2026-10-01' };
  const vendor = { vendorId: 'VND-KAVERI', sapVendorCode: '1120250081' };

  it('records the day SAP cleared it', async () => {
    restoreHttp = stubMiro();
    stubPayment({ ...LIVE_PAYMENT, STATUS: 'CLEARED', CLEARING_DOCUMENT: '1500000123', CLEARING_DATE: '2026-10-15' });
    const driver = createS4ODataDriver({ config: CONFIG, secrets: {} });
    const handler = jest.fn(async () => ({}));

    await expect(driver.awaitPaymentRun({ invoice, vendor, vendorId: vendor.vendorId }, handler)).resolves.toBe(true);

    expect(handler.mock.calls[0][0].data.paymentDate.toISOString().slice(0, 10)).toBe('2026-10-15');
  });

  it('records nothing — rather than paying it today — when the clearing date is unreadable', async () => {
    restoreHttp = stubMiro();
    stubPayment({ ...LIVE_PAYMENT, STATUS: 'CLEARED', CLEARING_DOCUMENT: '1500000123', CLEARING_DATE: '' });
    const driver = createS4ODataDriver({ config: CONFIG, secrets: {} });
    const handler = jest.fn();

    await expect(driver.awaitPaymentRun({ invoice, vendor, vendorId: vendor.vendorId }, handler)).resolves.toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
