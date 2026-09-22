const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createAdminUser } = require('./helpers');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { invalidateSapAdapter } = require('../sap');

// Asset purchase orders — POST /api/pos/asset, the one endpoint in this
// application that creates a document in SAP (ADR-0042).
//
// What is worth testing here is not the arithmetic (there is barely any) but
// the guardrails, because the failure modes are expensive and irreversible:
// a supplier raising capex against themselves, an order recorded locally that
// SAP never created, or an order created in SAP that the portal then failed to
// record. The driver-level contract (payload shape, date format, envelope
// checking) is pinned separately in sap-read-contracts.test.js.

const app = buildTestApp();

const VALID = {
  companyCode: 'SSDN',
  purchasingOrg: 'SSDN',
  purchasingGroup: 'SDN',
  docType: 'NB',
  paymentTerms: '0001',
  currency: 'INR',
  docDate: '2026-09-16',
  items: [{
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
  }],
};

// An approved supplier with an SAP vendor master — the only kind an asset PO
// can name. `onboarded: true` gets the vendor to Approved; sapVendorCode is set
// directly because XK01 runs against the mock at approval and this test is not
// about that path.
const approvedVendor = async (vendorId, gstin) => {
  const { vendor } = await registerVendor(app, { vendorId, gstin }, { onboarded: true });
  await runWithTenant('CLT-0001', () => prisma.vendor.update({
    where: { pk: vendor.pk },
    data: { status: 'Approved', sapVendorCode: '1120250010' },
  }));
  return vendor;
};

const create = (token, body) =>
  request(app).post('/api/pos/asset').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /api/pos/asset', () => {
  it('creates the order in SAP and records it with the number SAP returned', async () => {
    const vendor = await approvedVendor('vendor_asset_1', '27AAAAA2001A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-1@example.com' });

    const res = await create(token, { ...VALID, vendorId: vendor.vendorId });

    expect(res.status).toBe(201);
    // The mock mints a 45xxxxxxxx number the way SAP would. What matters is
    // that the stored number came from the driver, not from the controller.
    expect(res.body.po.sapPoNumber).toMatch(/^45\d{8}$/);
    expect(res.body.message).toContain(res.body.po.sapPoNumber);

    const stored = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({
      where: { id: res.body.po.id },
      include: { items: true },
    }));

    expect(stored.sapPoNumber).toBe(res.body.po.sapPoNumber);
    expect(stored.sapDocNumber).toBe(res.body.po.sapPoNumber);
    // 'synced', not 'pending': this order IS SAP's from the moment it was
    // created, unlike an awarded one waiting to be correlated. It is also what
    // stops sweepPurchaseOrders creating a duplicate when it rediscovers it.
    expect(stored.sapSyncState).toBe('synced');
    expect(stored.status).toBe('Open');
    expect(stored.companyCode).toBe('SSDN');

    expect(stored.items).toHaveLength(1);
    const [item] = stored.items;
    expect(item.assetNumber).toBe('000000000701');
    expect(item.assetSubNumber).toBe('0000');
    expect(item.materialGroup).toBe('018');
    expect(item.storageLocation).toBe('SSDN');
    expect(item.taxCode).toBe('V0');
    expect(item.plant).toBe('SSDN');
    // An asset line is text-only — SHORT_TEXT, no MATNR. '' matches what
    // zpo_grn_vendor/Detail returns for a text line.
    expect(item.materialCode).toBe('');
    expect(Number(item.netValue)).toBe(50000);
    expect(item.line).toBe(10);
  });

  it('records who chose the asset number, since nothing else can verify it', async () => {
    const vendor = await approvedVendor('vendor_asset_2', '27AAAAA2002A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-2@example.com' });

    const res = await create(token, { ...VALID, vendorId: vendor.vendorId });
    expect(res.status).toBe(201);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'po.asset_created', target: { path: ['id'], equals: res.body.po.id } },
    });

    expect(entry).toBeTruthy();
    expect(entry.actorEmail).toBe('asset-admin-2@example.com');
    expect(entry.meta.assets).toEqual([{ line: 10, assetNumber: '000000000701', assetSubNumber: '0000' }]);
    expect(entry.meta.totalValue).toBe(50000);
  });

  it('refuses a supplier outright — raising capex is never the vendor\'s call', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_asset_3', gstin: '27AAAAA2003A1Z1' }, { onboarded: true });

    const res = await create(token, { ...VALID, vendorId: vendor.vendorId });

    expect(res.status).toBe(403);
    const count = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.count({ where: { vendorId: vendor.vendorId } }));
    expect(count).toBe(0);
  });

  it('refuses a vendor with no SAP vendor master rather than letting SAP reject it', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_asset_4', gstin: '27AAAAA2004A1Z1' }, { onboarded: true });
    await runWithTenant('CLT-0001', () => prisma.vendor.update({
      where: { pk: vendor.pk }, data: { status: 'Approved', sapVendorCode: null },
    }));
    const { token } = await createAdminUser({ email: 'asset-admin-4@example.com' });

    const res = await create(token, { ...VALID, vendorId: vendor.vendorId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no SAP vendor master/i);
  });

  it('refuses a supplier who is not approved yet', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_asset_5', gstin: '27AAAAA2005A1Z1' });
    await runWithTenant('CLT-0001', () => prisma.vendor.update({
      where: { pk: vendor.pk }, data: { status: 'Under Review', sapVendorCode: '1120250010' },
    }));
    const { token } = await createAdminUser({ email: 'asset-admin-5@example.com' });

    const res = await create(token, { ...VALID, vendorId: vendor.vendorId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Under Review, not Approved/);
  });

  it('rejects a line with no asset number', async () => {
    const vendor = await approvedVendor('vendor_asset_6', '27AAAAA2006A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-6@example.com' });

    const res = await create(token, {
      ...VALID,
      vendorId: vendor.vendorId,
      items: [{ ...VALID.items[0], assetNumber: '' }],
    });

    expect(res.status).toBe(400);
  });

  it('rejects a non-numeric asset number rather than passing a typo to SAP', async () => {
    const vendor = await approvedVendor('vendor_asset_7', '27AAAAA2007A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-7@example.com' });

    const res = await create(token, {
      ...VALID,
      vendorId: vendor.vendorId,
      items: [{ ...VALID.items[0], assetNumber: 'ASSET-701' }],
    });

    expect(res.status).toBe(400);
  });

  it('rejects a description SAP would silently truncate at 40 characters', async () => {
    const vendor = await approvedVendor('vendor_asset_8', '27AAAAA2008A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-8@example.com' });

    const res = await create(token, {
      ...VALID,
      vendorId: vendor.vendorId,
      items: [{ ...VALID.items[0], description: 'A'.repeat(41) }],
    });

    expect(res.status).toBe(400);
  });

  it('requires organisational scope — none of it defaults to a demo value', async () => {
    // Issue #62: a value on a purchase order means a real one was supplied,
    // never that '1000' was assumed. An asset PO has no awarding RFQ to carry
    // these from.
    const vendor = await approvedVendor('vendor_asset_9', '27AAAAA2009A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-9@example.com' });

    for (const field of ['companyCode', 'purchasingOrg', 'purchasingGroup']) {
      const body = { ...VALID, vendorId: vendor.vendorId };
      delete body[field];
      const res = await create(token, body);
      expect(res.status).toBe(400);
    }
  });

  it('writes nothing locally when SAP refuses the order', async () => {
    // The whole reason this calls SAP before persisting. A local order claiming
    // an SAP document that was never created is the state §5.6 spent a phase
    // removing — it must not come back through this door.
    const vendor = await approvedVendor('vendor_asset_10', '27AAAAA2010A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-10@example.com' });

    // Driven through a real refusing driver rather than a stubbed module: the
    // ecc_rfc skeleton genuinely throws not_implemented for this method, so
    // this exercises the controller's actual failure path, adapter cache and
    // all, instead of a hand-rolled throw.
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 'ecc_rfc', config: {} },
    }));
    invalidateSapAdapter();

    const res = await create(token, { ...VALID, vendorId: vendor.vendorId });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const count = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.count({ where: { vendorId: vendor.vendorId } }));
    expect(count).toBe(0);
  });

  it('defaults the asset sub-number to 0000 (the main asset), not to blank', async () => {
    const vendor = await approvedVendor('vendor_asset_11', '27AAAAA2011A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-11@example.com' });

    const body = { ...VALID, vendorId: vendor.vendorId, items: [{ ...VALID.items[0] }] };
    delete body.items[0].assetSubNumber;

    const res = await create(token, body);

    expect(res.status).toBe(201);
    expect(res.body.po.items[0].assetSubNumber).toBe('0000');
  });

  it('divides the line value by the price unit, and stores the price unit', async () => {
    // Issue #108. SAP's NETPR is the price for PEINH units, so 200 units at
    // 10,000 per 100 is a 20,000 line, not a 2,000,000 one. Every other case in
    // this file pins `priceUnit: 1`, which is exactly what let the missing
    // divisor ship — this is the case that fails without it.
    const vendor = await approvedVendor('vendor_asset_13', '27AAAAA2013A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-13@example.com' });

    const res = await create(token, {
      ...VALID,
      vendorId: vendor.vendorId,
      items: [{ ...VALID.items[0], quantity: 200, unitPrice: 10000, priceUnit: 100 }],
    });

    expect(res.status).toBe(201);

    const stored = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({
      where: { id: res.body.po.id },
      include: { items: true },
    }));

    const [item] = stored.items;
    expect(Number(item.netValue)).toBe(20000);
    // Stored, not just forwarded to SAP: without it the value cannot be
    // re-derived or reconciled.
    expect(item.priceUnit).toBe(100);
  });

  it('defaults the price unit to 1 when the caller does not state one', async () => {
    const vendor = await approvedVendor('vendor_asset_14', '27AAAAA2014A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-14@example.com' });

    const body = { ...VALID, vendorId: vendor.vendorId, items: [{ ...VALID.items[0] }] };
    delete body.items[0].priceUnit;

    const res = await create(token, body);

    expect(res.status).toBe(201);
    const stored = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({
      where: { id: res.body.po.id },
      include: { items: true },
    }));
    expect(stored.items[0].priceUnit).toBe(1);
    expect(Number(stored.items[0].netValue)).toBe(50000);
  });

  it('records the audited total value with the price unit applied', async () => {
    const vendor = await approvedVendor('vendor_asset_15', '27AAAAA2015A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-15@example.com' });

    const res = await create(token, {
      ...VALID,
      vendorId: vendor.vendorId,
      items: [{ ...VALID.items[0], quantity: 200, unitPrice: 10000, priceUnit: 100 }],
    });
    expect(res.status).toBe(201);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'po.asset_created', target: { path: ['id'], equals: res.body.po.id } },
    });
    expect(entry.meta.totalValue).toBe(20000);
  });

  it('numbers lines 10, 20, 30 the way every other document in this app does', async () => {
    const vendor = await approvedVendor('vendor_asset_12', '27AAAAA2012A1Z1');
    const { token } = await createAdminUser({ email: 'asset-admin-12@example.com' });

    const res = await create(token, {
      ...VALID,
      vendorId: vendor.vendorId,
      items: [
        { ...VALID.items[0], description: 'Line one' },
        { ...VALID.items[0], description: 'Line two', assetNumber: '000000000702' },
        { ...VALID.items[0], description: 'Line three', assetNumber: '000000000703' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.po.items.map((item) => item.line)).toEqual([10, 20, 30]);
  });
});
