// Issue: SAP document numbers were stored without a fiscal/material-document
// year, so a GRN business id minted straight from the bare document number
// collides with an older receipt the moment SAP recycles a number range
// across a fiscal-year boundary (backend/prisma/schema.prisma's
// `@@unique([clientId, id])` on GRN). Three things are exercised here:
//
//   1. the s4odata driver mints the year into the id and stores it on its own
//      column, deriving it from the receipt date since the live Z endpoint
//      carries no MJAHR-equivalent field yet;
//   2. the schema change actually does what it's for — two receipts with the
//      same bare document number in different years both persist;
//   3. jobs/handlers/awaitGoodsReceipt.js treats a collision on the id it was
//      about to create as "this receipt is already recorded", not a SAP
//      failure to back off and eventually abandon.
const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const awaitGoodsReceiptHandler = require('../jobs/handlers/awaitGoodsReceipt');

/**
 * Stubs Node's `http.request` — the transport the s4odata driver's
 * getWithBody() uses for zpo_grn_vendor/Detail (a GET whose filter travels in
 * a JSON body, so it goes around fetch). See tests/sap-read-contracts.test.js
 * for the original of this helper.
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

const poGrnPayload = ({ grNumber = '5000001234', grDate = '20260115', extraGrFields = {} } = {}) => ([{
  PO_NUMBER: '4500012345',
  PO_DATE: '01.01.2026',
  BUYER_NAME: 'Buyer',
  SHIP_TO_CITY: 'Pune',
  SHIP_TO_STATE: 'MH',
  COM_CODE: '1000',
  CURRENCY: 'INR',
  PO_LINE_ITEMS: [{
    ITEM_NUMBER: '10',
    MATERIAL_CODE: 'MAT-1',
    DESCRIPTION: 'Widget',
    ORDERED_QUANTITY: '10',
    RECEIVED_QUANTITY: '10',
    INVOICED_QUANTITY: '0',
    UOM: 'EA',
    UNIT_PRICE: '50',
    NET_AMOUNT: '500',
    GROSS_AMOUNT: '590',
    PLANT: '1000',
    GRN: [{ GR_NUMBER: grNumber, GR_ITEM_NUMBER: '1', GR_DATE: grDate, GR_QUANTITY: '10', UOM: 'EA', UNIT_PRICE: '50', NET_AMOUNT: '500', ...extraGrFields }],
  }],
}]);

const driverFor = () => createS4ODataDriver({ config: { baseUrl: 'http://sandbox', sapClient: '800' }, secrets: {} });

const poFor = (grNumber, grDate) => ({
  sapPoNumber: '4500012345',
  items: [{ line: 10, invoicePlan: { enabled: false } }],
});

// The driver's awaitGoodsReceipt looks the vendor up itself (it has no other
// way to learn the SAP vendor code) — needs a real Vendor row and a bound
// tenant, like every other tenant-scoped query in this app.
const seedVendor = (clientId, vendorId) => runWithTenant(clientId, () => prisma.vendor.create({
  data: {
    vendorId, sapVendorCode: 'VEN0001', companyName: `${vendorId} Pvt Ltd`,
    gstin: '27AAAAA0000A1Z5', pan: 'AAAAA0000A', email: `${vendorId}@example.com`,
  },
}));

describe('GRN fiscal-year handling (s4odata driver)', () => {
  it('mints the id and sapDocYear from the receipt date when SAP sends no MJAHR', async () => {
    await seedVendor('CLT-0001', 'vendor_fy_driver_1');
    const { restore } = mockHttpRequest(JSON.stringify(poGrnPayload({ grNumber: '5000001234', grDate: '20260115' })));
    let received;
    try {
      await runWithTenant('CLT-0001', () => driverFor().awaitGoodsReceipt(
        { asn: { items: [{ line: 10 }] }, po: poFor(), vendorId: 'vendor_fy_driver_1' },
        async (answer) => { received = answer.data; return {}; },
      ));
    } finally { restore(); }

    expect(received.grnId).toBe('GRN-2026-5000001234');
    expect(received.sapDocYear).toBe(2026);
    expect(received.sapMigoDoc).toBe('5000001234');
  });

  it('prefers a real MJAHR/GR_YEAR field over the derived year, when SAP sends one', async () => {
    await seedVendor('CLT-0001', 'vendor_fy_driver_2');
    const { restore } = mockHttpRequest(JSON.stringify(
      poGrnPayload({ grNumber: '5000001234', grDate: '20260115', extraGrFields: { MJAHR: '2025' } }),
    ));
    let received;
    try {
      await runWithTenant('CLT-0001', () => driverFor().awaitGoodsReceipt(
        { asn: { items: [{ line: 10 }] }, po: poFor(), vendorId: 'vendor_fy_driver_2' },
        async (answer) => { received = answer.data; return {}; },
      ));
    } finally { restore(); }

    expect(received.grnId).toBe('GRN-2025-5000001234');
    expect(received.sapDocYear).toBe(2025);
  });

  it('gives the same bare document number distinct ids across a fiscal-year boundary', async () => {
    await seedVendor('CLT-0001', 'vendor_fy_driver_3');

    const yearOne = mockHttpRequest(JSON.stringify(poGrnPayload({ grNumber: '5000009999', grDate: '20251230' })));
    let firstYear;
    try {
      await runWithTenant('CLT-0001', () => driverFor().awaitGoodsReceipt(
        { asn: { items: [{ line: 10 }] }, po: poFor(), vendorId: 'vendor_fy_driver_3' },
        async (answer) => { firstYear = answer.data; return {}; },
      ));
    } finally { yearOne.restore(); }

    const yearTwo = mockHttpRequest(JSON.stringify(poGrnPayload({ grNumber: '5000009999', grDate: '20260105' })));
    let secondYear;
    try {
      await runWithTenant('CLT-0001', () => driverFor().awaitGoodsReceipt(
        { asn: { items: [{ line: 10 }] }, po: poFor(), vendorId: 'vendor_fy_driver_3' },
        async (answer) => { secondYear = answer.data; return {}; },
      ));
    } finally { yearTwo.restore(); }

    expect(firstYear.sapMigoDoc).toBe(secondYear.sapMigoDoc);
    expect(firstYear.grnId).not.toBe(secondYear.grnId);
  });
});

const seedPoAsn = async (clientId, suffix) => {
  const po = await prisma.purchaseOrder.create({
    data: { id: `PO-FY-${suffix}`, vendorId: `vendor_fy_${suffix}`, status: 'Acknowledged', sapPoNumber: `450009${suffix}`, sapDocNumber: `450009${suffix}`, sapSyncState: 'synced' },
  });
  const asn = await prisma.aSN.create({
    data: { id: `ASN-FY-${suffix}`, poId: po.id, vendorId: `vendor_fy_${suffix}`, status: 'Submitted', shipDate: new Date(), estimatedDeliveryDate: new Date() },
  });
  return { po, asn };
};

describe('GRN.sapDocYear — the constraint this exists for', () => {
  it('lets two receipts with the same MBLNR in different years both persist', async () => {
    await runWithTenant('CLT-0001', async () => {
      const { po: po1, asn: asn1 } = await seedPoAsn('CLT-0001', 'y1');
      const { po: po2, asn: asn2 } = await seedPoAsn('CLT-0001', 'y2');

      const bareNumber = '5000005555';
      const yearOne = await prisma.gRN.create({
        data: { id: `GRN-2025-${bareNumber}`, poId: po1.id, asnId: asn1.id, vendorId: po1.vendorId, sapMigoDoc: bareNumber, sapDocYear: 2025, postingDate: new Date('2025-03-20') },
      });
      const yearTwo = await prisma.gRN.create({
        data: { id: `GRN-2026-${bareNumber}`, poId: po2.id, asnId: asn2.id, vendorId: po2.vendorId, sapMigoDoc: bareNumber, sapDocYear: 2026, postingDate: new Date('2026-01-10') },
      });

      expect(yearOne.sapMigoDoc).toBe(yearTwo.sapMigoDoc);
      expect(yearOne.id).not.toBe(yearTwo.id);
    });
  });
});

describe('jobs/handlers/awaitGoodsReceipt — a colliding id is already handled', () => {
  it('recognises a unique-constraint violation on the minted id as done, not a SAP failure', async () => {
    await runWithTenant('CLT-0001', async () => {
      const { po, asn } = await seedPoAsn('CLT-0001', 'collide');
      const grnId = 'GRN-2026-COLLIDE-1';

      // Precondition: this exact receipt was already recorded — by a prior
      // attempt of this same job racing another worker, the scenario this
      // fix exists for. Constructing that race honestly (two real concurrent
      // job runs) is not what's under test here; the row itself is.
      await prisma.gRN.create({
        data: { id: grnId, poId: po.id, asnId: asn.id, vendorId: po.vendorId, sapMigoDoc: 'COLLIDE-1', sapDocYear: 2026, postingDate: new Date() },
      });

      const adapter = {
        awaitGoodsReceipt: async (ctx, handler) => {
          await handler({
            grnId,
            sapMigoDoc: 'COLLIDE-1',
            sapDocYear: 2026,
            postingDate: new Date(),
            receivedBy: 'SAP',
            items: [],
          });
          return true;
        },
      };

      const result = await awaitGoodsReceiptHandler({
        job: { clientId: 'CLT-0001', args: { asnId: asn.id, poId: po.id, vendorId: po.vendorId }, createdAt: new Date() },
        adapter,
      });

      expect(result).toEqual({ done: true });

      const rows = await prisma.gRN.findMany({ where: { id: grnId } });
      expect(rows).toHaveLength(1);
    });
  });
});
