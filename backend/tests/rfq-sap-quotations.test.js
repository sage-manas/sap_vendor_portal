const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor } = require('./helpers');
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');

// GET /api/rfqs/sap-quotations wraps the ME48 read (ZCL_ME48/vendor on a real
// system) — see vendorQuotationDisplay in sap/drivers/s4odata.driver.js. The
// live endpoint is named for quotations but returns the vendor's whole
// purchasing-document set, so these exercise both document types coming back
// together, the type filter, and the vendor-code guard that keeps us from
// making the unfiltered call that dumps every supplier's documents.

const app = buildTestApp();

// registerVendor leaves sapVendorCode unset — SAP assigns it at approval. The
// ME48 read is keyed on exactly that code, so every case that expects rows has
// to give the vendor one first.
const withSapCode = (vendorId, code = '1120250010') =>
  runWithTenant('CLT-0001', () => prisma.vendor.updateMany({ where: { vendorId }, data: { sapVendorCode: code } }));

const seedRFQ = (vendorId, overrides = {}) =>
  runWithTenant('CLT-0001', () => prisma.rFQ.create({
    data: {
      id: overrides.id || 'RFQ-2026-001',
      description: 'Steel pipes',
      deadlineDate: new Date('2026-03-01'),
      createdDate: overrides.createdDate || new Date('2026-01-08'),
      invitedVendors: { create: [{ clientId: 'CLT-0001', vendorExtId: vendorId, name: 'Test Vendor' }] },
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-3849', description: 'Steel Pipe', quantity: 10, uom: 'EA' }] },
    },
  }));

const seedPO = (vendorId, overrides = {}) =>
  runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: overrides.id || 'PO-2026-0001',
      sapPoNumber: overrides.sapPoNumber || '4500022503',
      vendorId,
      buyerName: 'Test Buyer',
      plant: '1000',
      status: 'Open',
      createdDate: overrides.createdDate || new Date('2025-11-12'),
      items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-3849', description: 'Steel Pipe', quantity: 10, grnQuantity: 0, unitPrice: 100, netValue: 1000 }] },
    },
  }));

describe('GET /api/rfqs/sap-quotations', () => {
  it('returns quotations and purchase orders together, each tagged with its type', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_me48_1', gstin: '27AAAAA0101A1Z1' }, { onboarded: true });
    await withSapCode(vendor.vendorId);
    await seedRFQ(vendor.vendorId);
    await seedPO(vendor.vendorId);

    const res = await request(app).get('/api/rfqs/sap-quotations').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);

    const byType = Object.fromEntries(res.body.documents.map((d) => [d.documentType, d]));
    expect(Object.keys(byType).sort()).toEqual(['Purchase Order', 'Quotation']);
    expect(byType['Purchase Order'].documentNumber).toBe('4500022503');
    // The quotation number range on this system is 6xxxxxxx.
    expect(byType.Quotation.documentNumber).toMatch(/^6\d{9}$/);
  });

  it('sends dates in SAP\'s YYYYMMDD form, as the live endpoint does', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_me48_2', gstin: '27AAAAA0102A1Z1' }, { onboarded: true });
    await withSapCode(vendor.vendorId);
    await seedPO(vendor.vendorId, { createdDate: new Date('2025-11-12') });

    const res = await request(app).get('/api/rfqs/sap-quotations').set('Authorization', `Bearer ${token}`);

    expect(res.body.documents[0].date).toBe('20251112');
  });

  it('?type filters to one document category', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_me48_3', gstin: '27AAAAA0103A1Z1' }, { onboarded: true });
    await withSapCode(vendor.vendorId);
    await seedRFQ(vendor.vendorId);
    await seedPO(vendor.vendorId);

    const res = await request(app)
      .get('/api/rfqs/sap-quotations?type=Purchase%20Order')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].documentType).toBe('Purchase Order');
  });

  it('returns nothing, and never calls SAP, for a vendor with no SAP code', async () => {
    // Guard, not an optimisation: ZCL_ME48/vendor with an empty LIFNR answers
    // 200 with every purchasing document in the client — every other
    // supplier's included — so this call must not be made at all.
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_me48_4', gstin: '27AAAAA0104A1Z1' }, { onboarded: true });
    await seedPO(vendor.vendorId);
    await runWithTenant('CLT-0001', () => prisma.vendor.updateMany({ where: { vendorId: vendor.vendorId }, data: { sapVendorCode: '' } }));

    const findSpy = jest.spyOn(prisma.purchaseOrder, 'findMany');

    const res = await request(app).get('/api/rfqs/sap-quotations').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.documents).toEqual([]);
    // Bailing before the document reads proves we never reached the SAP call.
    expect(findSpy).not.toHaveBeenCalled();

    findSpy.mockRestore();
  });

  it('only ever reports the caller\'s own documents', async () => {
    const a = await registerVendor(app, { vendorId: 'vendor_me48_5a', gstin: '27AAAAA0105A1Z1', email: 'me485a@example.com' }, { onboarded: true });
    const b = await registerVendor(app, { vendorId: 'vendor_me48_5b', gstin: '27AAAAA0106A1Z1', email: 'me485b@example.com' }, { onboarded: true });
    await withSapCode(a.vendor.vendorId);
    await withSapCode(b.vendor.vendorId, '1120250011');
    await seedPO(a.vendor.vendorId, { id: 'PO-2026-A', sapPoNumber: '4500030001' });
    await seedPO(b.vendor.vendorId, { id: 'PO-2026-B', sapPoNumber: '4500030002' });

    const resA = await request(app).get('/api/rfqs/sap-quotations').set('Authorization', `Bearer ${a.token}`);
    const resB = await request(app).get('/api/rfqs/sap-quotations').set('Authorization', `Bearer ${b.token}`);

    expect(resA.body.documents.map((d) => d.documentNumber)).toEqual(['4500030001']);
    expect(resB.body.documents.map((d) => d.documentNumber)).toEqual(['4500030002']);
  });

  it('requires an authenticated vendor', async () => {
    const res = await request(app).get('/api/rfqs/sap-quotations');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
