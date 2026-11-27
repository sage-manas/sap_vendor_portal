// Issue #351. Facts the portal used to assert that SAP never reported:
//
//   - every goods receipt read from SAP was written as fully accepted, so the
//     screen badged it "QC Passed" and the supplier's quality score read it as
//     inspected — zpo_grn_vendor/Detail carries no inspection data at all;
//   - a payment SAP reported no method for was NEFT, one with no UTR got
//     `SWEEP-<timestamp>`, and SAP's real method ('C', Cheque, on the live
//     sandbox) could not be stored, because paymentMethod was an
//     NEFT/RTGS/IMPS enum.
const request = require('supertest');
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');
const sweepPurchaseOrders = require('../jobs/handlers/sweepPurchaseOrders');
const sweepPayments = require('../jobs/handlers/sweepPayments');
const buildTestApp = require('./testApp');
const { registerVendor } = require('./helpers');

// The live zpo_grn_vendor/Detail row for PO 4500022839, captured read-only on
// 2026-11-27 (vendor 1120250081). One goods receipt, 4900004426, and nothing
// about inspection anywhere in it.
const LIVE_PO_WITH_RECEIPT = {
  REGION: 'India', PO_NUMBER: '4500022839', PO_DATE: '21.09.2026', BUYER_NAME: 'SSDN Technologies Pvt. Ltd.',
  BUYER_GSTIN: '07AAACC1206D2ZJ', SHIP_TO_CITY: 'Gurgaon', SHIP_TO_STATE: 'Haryana',
  VENDOR_ID: '1120250081', VENDOR_NAME: 'Kaveri Forge & Fittings', VENDOR_GSTIN: '27AAECK4821M1Z6',
  CURRENCY: 'INR', NET_AMOUNT: '0.00 ', GROSS_AMOUNT: '59000.00 ', COM_CODE: 'SSDN',
  PO_LINE_ITEMS: [{
    PO_NUMBER: '4500022839', ITEM_NUMBER: '00010', TYPE: 'NB', MATERIAL_CODE: '', DESCRIPTION: 'ASSET TESTING',
    ORDERED_QUANTITY: '5.000 ', GR_EXPECTED: 'Closed', RECEIVED_QUANTITY: '5.000', INVOICED_QUANTITY: '0.000', UOM: 'EA',
    UNIT_PRICE: '10000.00 ', NET_AMOUNT: '50000.00 ', TAX_CODE: 'R2', GROSS_AMOUNT: '59000.00 ', PLANT: 'SSDN',
    ACC_ASSIGNMNT_CAT: 'A', INV_PLANNO: '',
    GRN: [{
      GR_NUMBER: '4900004426', GR_DATE: '20260921', PO_NUMBER: '4500022839', DELIVERY_NOTE: '', VENDOR_ID: '1120250081',
      PO_ITEM_NUMBER: '00010', MATERIAL_CODE: '', DESCRIPTION: 'ASSET TESTING', GR_QUANTITY: '5.000 ', UOM: '',
      UNIT_PRICE: '10000.00 ', NET_AMOUNT: '50000 ', STATUS: '', LOCATION: '', GR_ITEM_NUMBER: '0001',
      SPO_ITEM_NUMBER: '', SACC_CAT: '', SITEM_CAT: '', SNET_AMOUNT: '', SSES_NO: '', SSES_YEAR: '',
    }],
  }],
};

// The live /ZPAYM_METHOD/PAYM_METHOD catalogue, verbatim.
const LIVE_PAYMENT_METHODS = [
  { PAYMENT_METHOD: '1', DESCRIPTION: 'paymet by check' }, { PAYMENT_METHOD: '5', DESCRIPTION: 'paymet by check HPL1' },
  { PAYMENT_METHOD: 'C', DESCRIPTION: 'Cheque' }, { PAYMENT_METHOD: 'H', DESCRIPTION: 'Payment method for HP00' },
  { PAYMENT_METHOD: 'K', DESCRIPTION: ' cheque for kanvi' }, { PAYMENT_METHOD: 'R', DESCRIPTION: 'Cheque' },
  { PAYMENT_METHOD: 'S', DESCRIPTION: 'check payment spl1' }, { PAYMENT_METHOD: 'T', DESCRIPTION: 'Bank Transfer' },
  { PAYMENT_METHOD: 'U', DESCRIPTION: 'Cheque' },
];

const CONFIG = { baseUrl: 'http://sandbox', sapClient: '800', companyCode: 'SSDN' };

const stubHttp = (body) => {
  const http = require('http');
  const original = http.request;
  http.request = (url, options, callback) => ({
    write: () => {},
    end: () => callback({
      statusCode: 200,
      statusMessage: 'OK',
      on: (event, handler) => {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
      },
    }),
    on: () => {},
    destroy: () => {},
  });
  return () => { http.request = original; };
};

const respondTo = (routes) => {
  global.fetch = jest.fn(async (url) => {
    const [, answer] = Object.entries(routes).find(([path]) => String(url).includes(path)) || [];
    if (answer instanceof Error) throw answer;
    return {
      status: answer ? 200 : 404, statusText: answer ? 'OK' : 'Not Found', ok: Boolean(answer),
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => JSON.stringify(answer ?? {}),
    };
  });
};

let restoreHttp;
afterEach(() => {
  if (restoreHttp) restoreHttp();
  restoreHttp = null;
  delete global.fetch;
});

describe('a goods receipt read from SAP', () => {
  const app = buildTestApp();

  // A registered supplier standing in for Kaveri Forge: its SAP code and
  // GSTIN are the live ones, so the order's party checks pass.
  const kaveri = async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await runWithTenant('CLT-0001', () => prisma.vendor.updateMany({
      where: { vendorId: vendor.vendorId }, data: { sapVendorCode: '1120250081', gstin: '27AAECK4821M1Z6' },
    }));
    // Restored straight after the sweep: supertest's own requests below go
    // through http.request too.
    const restore = stubHttp([LIVE_PO_WITH_RECEIPT]);
    try {
      await runWithTenant('CLT-0001', () => sweepPurchaseOrders({
        job: { clientId: 'CLT-0001', args: {} },
        adapter: buildTransientAdapter({ clientId: 'CLT-0001', driver: 's4_odata', config: CONFIG, secrets: {} }),
      }));
    } finally { restore(); }
    return { token, vendor };
  };

  it('is recorded as received and not inspected — not as all accepted', async () => {
    await kaveri();

    const item = await runWithTenant('CLT-0001', () => prisma.grnItem.findFirst({ where: { grn: { sapMigoDoc: '4900004426' } } }));
    expect(Number(item.receivedQuantity)).toBe(5);
    expect(item.acceptedQuantity).toBeNull();
    expect(item.rejectedQuantity).toBeNull();
  });

  it('reports no acceptance total for a receipt nobody inspected', async () => {
    const { token } = await kaveri();

    const res = await request(app).get('/api/grns').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const grn = res.body.grns.find((row) => row.sapMigoDoc === '4900004426');
    expect(grn.totalAccepted).toBeNull();
    expect(grn.rejectionRate).toBeNull();
  });

  it('is left out of the quality score, rather than scored as rejected', async () => {
    const { token, vendor } = await kaveri();
    // Plus one receipt that was inspected: 9 of 10 accepted.
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { sapPoNumber: '4500022839' } }));
    await runWithTenant('CLT-0001', () => prisma.gRN.create({
      data: {
        id: 'GRN-INSPECTED-1', poId: po.id, vendorId: vendor.vendorId, postingDate: new Date(),
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'M', receivedQuantity: 10, acceptedQuantity: 9, rejectedQuantity: 1 }] },
      },
    }));

    const res = await request(app).get('/api/vendors/performance').set('Authorization', `Bearer ${token}`);

    // 9/10 — not 9/15, which is what counting the uninspected 5 would give.
    expect(res.body.qualityAcceptance).toBe(90);

    // The dashboard's "accepted on receipt" share has the same denominator.
    const summary = await request(app).get('/api/dashboard/summary').set('Authorization', `Bearer ${token}`);
    expect(summary.body.grns).toMatchObject({ receivedQuantity: 15, inspectedQuantity: 10, acceptedQuantity: 9 });
  });
});

describe('a payment SAP reports', () => {
  const PAYMENT = {
    INVOICE_NO: '5105609771', FISCAL_YEAR: 2026, STATUS: 'CLEARED', GROSS_AMOUNT: 25000, TDS_DEDUCTED: 0, NET_DISBURSED: 25000,
    CLEARING_DOCUMENT: '1500000123', CLEARING_DATE: '20261015', POSTING_DATE: '20261015', PAYMENT_METHOD: 'C', UTR_REFERENCE: '',
  };
  const driver = () => createS4ODataDriver({ config: CONFIG, secrets: {} });

  it('carries SAP\'s own payment method, decoded: C is Cheque', async () => {
    respondTo({ '/ZPAYM_METHOD/PAYM_METHOD': LIVE_PAYMENT_METHODS, '/zpayment_api/payment': PAYMENT });

    const { data } = await driver().invoicePaymentDetail({ invoiceDocNo: '5105609771', fiscalYear: '2026' });

    expect(data.paymentMethod).toBe('Cheque');
    expect(data.utrReference).toBeNull();
  });

  it('shows a code the catalogue does not know as SAP sent it, not a guess', async () => {
    respondTo({ '/ZPAYM_METHOD/PAYM_METHOD': LIVE_PAYMENT_METHODS, '/zpayment_api/payment': { ...PAYMENT, PAYMENT_METHOD: 'Z' } });

    const { data } = await driver().invoicePaymentDetail({ invoiceDocNo: '5105609771', fiscalYear: '2026' });

    expect(data.paymentMethod).toBe('Z');
  });

  it('still reads the payment when the method catalogue cannot be read', async () => {
    respondTo({ '/ZPAYM_METHOD/PAYM_METHOD': new Error('catalogue down'), '/zpayment_api/payment': PAYMENT });

    const { data } = await driver().invoicePaymentDetail({ invoiceDocNo: '5105609771', fiscalYear: '2026' });

    expect(data.paymentMethod).toBe('C');
  });

  it('is recorded without a method or UTR SAP did not send', async () => {
    const { vendor } = await registerVendor(buildTestApp(), {}, { onboarded: true });
    await runWithTenant('CLT-0001', () => prisma.vendor.updateMany({ where: { vendorId: vendor.vendorId }, data: { sapVendorCode: 'VENPAYNULL' } }));
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: { id: 'PO-PAYNULL-1', vendorId: vendor.vendorId, status: 'Open', sapPoNumber: '4500097101', sapDocNumber: '4500097101', sapSyncState: 'synced' },
    }));
    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-PAYNULL-1', poId: po.id, vendorId: vendor.vendorId, invoiceNumber: 'TESTING', sapMiroDoc: '5105609771',
        invoiceDate: new Date(), status: 'Submitted', subTotal: 25000, taxAmount: 0, totalAmount: 25000,
      },
    }));

    await runWithTenant('CLT-0001', () => sweepPayments({
      job: { clientId: 'CLT-0001', args: {} },
      adapter: buildTransientAdapter({
        clientId: 'CLT-0001',
        driver: 'mock',
        config: {
          discoveries: {
            payment: [{
              poId: po.sapPoNumber, sapMiroDoc: '5105609771', grossAmount: 25000, netAmount: 25000,
              paymentDate: new Date('2026-10-15'), sapPaymentDoc: '1500000123', paymentMethod: null, utrCode: null,
            }],
          },
          behaviour: { paymentMethod: null },
        },
        secrets: {},
      }),
    }));

    const payment = await runWithTenant('CLT-0001', () => prisma.payment.findFirst({ where: { items: { some: { invoiceId: invoice.id } } } }));
    expect(payment).toBeTruthy();
    expect(payment.paymentMethod).toBeNull();
    expect(payment.utrCode).toBeNull();
    // Keyed on SAP's clearing document, not the clock.
    expect(payment.id).toBe('PMT-SWEEP-1500000123');
  });
});
