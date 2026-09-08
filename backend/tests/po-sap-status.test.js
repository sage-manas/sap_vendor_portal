const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor } = require('./helpers');
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');

// GET /api/pos/sap-status wraps the SAP PO/GRN read (zpo_grn_vendor/Detail on
// a real system) with a per-tenant-per-vendor cache and optional date-sorted
// pagination — see backend/controllers/po.controller.js. This exercises both
// against the mock driver, which stands in for the slow SAP call.

const app = buildTestApp();

const seedPO = (overrides = {}) =>
  runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: overrides.id || 'PO-2026-0001',
      sapPoNumber: overrides.sapPoNumber || '4500010001',
      vendorId: overrides.vendorId,
      buyerName: 'Test Buyer',
      plant: '1000',
      status: 'Open',
      createdDate: overrides.createdDate || new Date('2026-01-10'),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-3849', description: 'Steel Pipe', quantity: 10, grnQuantity: 0, unitPrice: 100, netValue: 1000 }] },
    },
  }));

describe('GET /api/pos/sap-status', () => {
  it('returns every SAP order when no page/limit is given', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_1', gstin: '27AAAAA0001A1Z1' }, { onboarded: true });
    await seedPO({ vendorId: vendor.vendorId });

    const res = await request(app).get('/api/pos/sap-status').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeUndefined();
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].poNumber).toBe('4500010001');
  });

  it('serves the second request from cache instead of re-reading Mongo', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_2', gstin: '27AAAAA0002A1Z1' }, { onboarded: true });
    await seedPO({ vendorId: vendor.vendorId });

    const findSpy = jest.spyOn(prisma.purchaseOrder, 'findMany');

    const first = await request(app).get('/api/pos/sap-status').set('Authorization', `Bearer ${token}`);
    const second = await request(app).get('/api/pos/sap-status').set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    // Only the cache-miss path calls PurchaseOrder.find — one call total
    // across both requests proves the second one was served from cache.
    expect(findSpy).toHaveBeenCalledTimes(1);

    findSpy.mockRestore();
  });

  it('?refresh=true bypasses the cache', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_3', gstin: '27AAAAA0003A1Z1' }, { onboarded: true });
    await seedPO({ vendorId: vendor.vendorId });

    const findSpy = jest.spyOn(prisma.purchaseOrder, 'findMany');

    await request(app).get('/api/pos/sap-status').set('Authorization', `Bearer ${token}`);
    await request(app).get('/api/pos/sap-status?refresh=true').set('Authorization', `Bearer ${token}`);

    expect(findSpy).toHaveBeenCalledTimes(2);

    findSpy.mockRestore();
  });

  it('paginates by page/limit, newest poDate first, with a pagination block', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_sapstatus_4', gstin: '27AAAAA0004A1Z1' }, { onboarded: true });
    await seedPO({ vendorId: vendor.vendorId, id: 'PO-2026-0001', sapPoNumber: '4500010001', createdDate: new Date('2026-01-10') });
    await seedPO({ vendorId: vendor.vendorId, id: 'PO-2026-0002', sapPoNumber: '4500010002', createdDate: new Date('2026-03-05') });
    await seedPO({ vendorId: vendor.vendorId, id: 'PO-2026-0003', sapPoNumber: '4500010003', createdDate: new Date('2026-02-01') });

    const page1 = await request(app).get('/api/pos/sap-status?page=1&limit=2').set('Authorization', `Bearer ${token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.orders).toHaveLength(2);
    expect(page1.body.orders.map((o) => o.poNumber)).toEqual(['4500010002', '4500010003']);
    expect(page1.body.pagination).toEqual({ total: 3, page: 1, limit: 2, pages: 2 });

    const page2 = await request(app).get('/api/pos/sap-status?page=2&limit=2').set('Authorization', `Bearer ${token}`);
    expect(page2.body.orders).toHaveLength(1);
    expect(page2.body.orders[0].poNumber).toBe('4500010001');
    expect(page2.body.pagination).toEqual({ total: 3, page: 2, limit: 2, pages: 2 });
  });

  it('caches independently per vendor', async () => {
    const a = await registerVendor(app, { vendorId: 'vendor_sapstatus_5a', gstin: '27AAAAA0005A1Z1', email: 'sapstatus5a@example.com' }, { onboarded: true });
    const b = await registerVendor(app, { vendorId: 'vendor_sapstatus_5b', gstin: '27AAAAA0006A1Z1', email: 'sapstatus5b@example.com' }, { onboarded: true });
    await seedPO({ vendorId: a.vendor.vendorId, id: 'PO-2026-A', sapPoNumber: '4500020001' });
    await seedPO({ vendorId: b.vendor.vendorId, id: 'PO-2026-B', sapPoNumber: '4500020002' });

    const resA = await request(app).get('/api/pos/sap-status').set('Authorization', `Bearer ${a.token}`);
    const resB = await request(app).get('/api/pos/sap-status').set('Authorization', `Bearer ${b.token}`);

    expect(resA.body.orders.map((o) => o.poNumber)).toEqual(['4500020001']);
    expect(resB.body.orders.map((o) => o.poNumber)).toEqual(['4500020002']);
  });
});
