const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, asTenant } = require('./helpers');
const { getSapAdapterForClient, invalidateSapAdapter } = require('../sap');
const { createS4ODataDriver } = require('../sap/drivers/s4odata.driver');
const createInboundDelivery = require('../jobs/handlers/createInboundDelivery');

// ADR-0049: a shipment notice becomes an inbound delivery in SAP, and
// withdrawing the notice deletes it there first.
//
// Seeding note (AGENTS.md): the PO carrying an SAP number and the vendor
// carrying an SAP vendor code are preconditions — the sweep and vendor
// approval produce them, and neither is under test. ASNs, deliveries and
// cancellations are produced through the API and the job handler, against
// the mock driver (which mirrors the requested contract) or the S/4 driver
// with `fetch` stubbed.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const setup = async ({ sapPoNumber = '4500022828' } = {}) => {
  const a = await registerVendor(app, {
    vendorId: 'vendor_inb_a', companyName: 'Inbound Supplier Pvt Ltd', gstin: '27AAAAA6661A1Z1', pan: 'AAAAA6661A', email: 'inb-a@example.com',
  }, { onboarded: true });
  await asTenant(() => prisma.vendor.updateMany({ where: { vendorId: 'vendor_inb_a' }, data: { sapVendorCode: '1120250081' } }));
  await asTenant(() => prisma.purchaseOrder.create({
    data: {
      id: 'PO-2026-INB1',
      vendorId: 'vendor_inb_a',
      sapPoNumber,
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, unitPrice: 10, netValue: 1000 }] },
    },
  }));
  expect((await request(app).put('/api/pos/PO-2026-INB1/acknowledge').set(auth(a.token))).status).toBe(200);
  return a;
};

let invoiceSeq = 0;
const ship = async (token, quantity = 40) => {
  const res = await request(app).post('/api/pos/PO-2026-INB1/asn').set(auth(token)).send({
    shipDate: '2026-11-20T00:00:00.000Z',
    estimatedDeliveryDate: '2026-11-23T00:00:00.000Z',
    carrierName: 'Blue Dart',
    trackingNumber: 'BD-1',
    vehicleNumber: 'MH12AB1234',
    invoiceReference: `INV/26/${(invoiceSeq += 1)}`,
    invoiceDate: '2026-11-19T00:00:00.000Z',
    invoiceValue: 472,
    items: [{ line: 10, shippedQuantity: quantity }],
  });
  expect(res.status).toBe(201);
  return res.body.asn;
};

const runJob = (asnId, adapter) => asTenant(async () => createInboundDelivery({
  job: { clientId: 'CLT-0001', args: { asnId }, createdAt: new Date() },
  adapter: adapter || await getSapAdapterForClient('CLT-0001'),
}));

const asnRow = (id) => asTenant(() => prisma.aSN.findFirst({ where: { id } }));

describe('creating the inbound delivery', () => {
  it('is queued when the shipment is submitted', async () => {
    const a = await setup();
    const asn = await ship(a.token);

    const job = await withoutTenantScope(() => rawPrisma.sapJob.findUnique({
      where: { dedupeKey: `createInboundDelivery:CLT-0001:${asn.id}` },
    }));
    expect(job).toMatchObject({ kind: 'createInboundDelivery', status: 'pending' });
  });

  it('records the delivery number SAP returns, and asking again does not make a second', async () => {
    const a = await setup();
    const asn = await ship(a.token);

    expect(await runJob(asn.id)).toEqual({ done: true });
    const first = (await asnRow(asn.id)).sapInboundDelivery;
    expect(first).toMatch(/^018\d{7}$/);

    expect(await runJob(asn.id)).toEqual({ done: true });
    expect((await asnRow(asn.id)).sapInboundDelivery).toBe(first);
  });

  it('waits while the order has no SAP number to reference', async () => {
    const a = await setup({ sapPoNumber: null });
    const asn = await ship(a.token);

    expect(await runJob(asn.id)).toEqual({ done: false });
    expect((await asnRow(asn.id)).sapInboundDelivery).toBeNull();
  });

  it('finishes without a delivery on a connection that cannot create one', async () => {
    const a = await setup();
    const asn = await ship(a.token);
    const adapter = { inboundDeliveryCreate: jest.fn(async () => ({ created: false, reason: 'not_configured' })) };

    expect(await runJob(asn.id, adapter)).toEqual({ done: true });
    expect((await asnRow(asn.id)).sapInboundDelivery).toBeNull();
  });

  it('deletes the delivery it made if the supplier cancelled while SAP was making it', async () => {
    const a = await setup();
    const asn = await ship(a.token);
    const deleted = [];
    const adapter = {
      // The cancel lands between the job reading the ASN and SAP answering.
      inboundDeliveryCreate: jest.fn(async () => {
        await request(app).post(`/api/pos/PO-2026-INB1/asn/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'Truck did not leave' });
        return { created: true, delivery: '0180000123' };
      }),
      inboundDeliveryCancel: jest.fn(async ({ asn: row }) => { deleted.push(row.sapInboundDelivery); return { cancelled: true }; }),
    };

    await runJob(asn.id, adapter);

    expect(deleted).toEqual(['0180000123']);
    expect(await asnRow(asn.id)).toMatchObject({ status: 'Cancelled', sapInboundDelivery: null });
  });
});

describe('cancelling a shipment SAP holds a delivery for', () => {
  it('deletes the delivery in SAP, then cancels', async () => {
    const a = await setup();
    const asn = await ship(a.token);
    await runJob(asn.id);
    const delivery = (await asnRow(asn.id)).sapInboundDelivery;

    const res = await request(app).post(`/api/pos/PO-2026-INB1/asn/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'Wrong order' });

    expect(res.status).toBe(200);
    expect(await asnRow(asn.id)).toMatchObject({ status: 'Cancelled', sapInboundDelivery: null });
    const log = await asTenant(() => prisma.sapLog.findFirst({ where: { name: 'ZINB_DELIVERY_CANCEL', documentRef: delivery } }));
    expect(log).toBeTruthy();
    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'asn.cancelled' } }));
    expect(audit.meta).toMatchObject({ sapInboundDeliveryDeleted: delivery });
  });

  it('refuses, and changes nothing, when the connection cannot delete it', async () => {
    const a = await setup();
    const asn = await ship(a.token);
    await runJob(asn.id);
    const delivery = (await asnRow(asn.id)).sapInboundDelivery;

    // An S/4 connection whose create endpoint was configured (the delivery
    // exists) but whose delete endpoint was not.
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata', config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800', companyCode: '1000' } },
    }));
    invalidateSapAdapter();

    const res = await request(app).post(`/api/pos/PO-2026-INB1/asn/${asn.id}/cancel`).set(auth(a.token)).send({ reason: 'Wrong order' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(new RegExp(delivery));
    expect(await asnRow(asn.id)).toMatchObject({ status: 'Submitted', sapInboundDelivery: delivery });
  });
});

describe('the S/4 driver against the requested contract', () => {
  afterEach(() => { delete global.fetch; });

  const asn = {
    id: 'ASN-482913',
    vendorId: 'VND-1',
    shipDate: new Date('2026-11-20T00:00:00Z'),
    estimatedDeliveryDate: new Date('2026-11-23T00:00:00Z'),
    trackingNumber: 'BD-1',
    vehicleNumber: 'MH12AB1234',
    carrierName: 'Blue Dart',
    ewayBillNo: '123456789012',
    invoiceReference: 'INV/2526/0871',
    invoiceDate: new Date('2026-11-19T00:00:00Z'),
    items: [{ line: 10, shippedQuantity: '40.5', uom: 'ea' }],
  };
  const po = { sapPoNumber: '4500022828' };
  const vendor = { vendorId: 'VND-1', sapVendorCode: '1120250081' };

  const driver = (config, response, capture = {}) => {
    global.fetch = jest.fn(async (url, options) => {
      capture.url = url;
      capture.body = JSON.parse(options.body);
      return { status: 200, statusText: 'OK', ok: true, headers: { get: () => null, getSetCookie: () => [] }, text: async () => JSON.stringify(response) };
    });
    return createS4ODataDriver({ config: { baseUrl: 'http://103.206.131.27:8081', sapClient: '800', ...config }, secrets: {} });
  };

  it('sends nothing until the connection names the endpoint', async () => {
    const d = driver({}, {});

    expect(await d.inboundDeliveryCreate({ asn, po, vendor })).toEqual({ data: { created: false, reason: 'not_configured' } });
    expect(await d.inboundDeliveryCancel({ asn: { ...asn, sapInboundDelivery: '0180000123' } })).toEqual({ data: { cancelled: false, reason: 'not_configured' } });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts the shipment with the ASN id as the idempotency key, and reads SAP\'s number back', async () => {
    const capture = {};
    const d = driver({ inboundDeliveryCreatePath: '/zinb_delivery/create' }, { TYPE: 'S', MESSAGE: 'Inbound delivery 180000123 created', DELIVERY: '0180000123', RESULTS: [{ TYPE: 'S', PO_ITEM: '00010' }] }, capture);

    const { data } = await d.inboundDeliveryCreate({ asn, po, vendor });

    expect(data).toMatchObject({ created: true, delivery: '0180000123' });
    expect(capture.url).toBe('http://103.206.131.27:8081/zinb_delivery/create?sap-client=800');
    expect(capture.body).toEqual({
      VENDOR: '1120250081',
      PO_NUMBER: '4500022828',
      PORTAL_ASN: 'ASN-482913',
      INVOICE_NO: 'INV/2526/0871',
      INVOICE_DATE: '20261119',
      DELIVERY_DATE: '20261123',
      SHIP_DATE: '20261120',
      BILL_OF_LADING: 'BD-1',
      MEANS_OF_TRANSPORT_ID: 'MH12AB1234',
      CARRIER: 'Blue Dart',
      EWAY_BILL: '123456789012',
      ITEMS: [{ PO_NUMBER: '4500022828', PO_ITEM: '00010', QUANTITY: '40.500', UNIT: 'EA' }],
    });
  });

  it('treats success without a delivery number as a failure', async () => {
    const d = driver({ inboundDeliveryCreatePath: '/zinb_delivery/create' }, { TYPE: 'S', MESSAGE: 'ok' });

    await expect(d.inboundDeliveryCreate({ asn, po, vendor })).rejects.toThrow(/returned no DELIVERY/);
  });

  it('passes SAP\'s refusal to delete through as an error', async () => {
    const d = driver({ inboundDeliveryCancelPath: '/zinb_delivery/delete' }, { TYPE: 'E', MESSAGE: 'Goods receipt already posted for delivery 180000123' });

    await expect(d.inboundDeliveryCancel({ asn: { ...asn, sapInboundDelivery: '0180000123' } })).rejects.toThrow(/Goods receipt already posted/);
  });
});
