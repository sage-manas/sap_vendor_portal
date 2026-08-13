// The enforcement layer itself. If these fail, nothing else in the tenancy
// story can be trusted.
const RFQ = require('../models/RFQ');
const Vendor = require('../models/Vendor');
const Client = require('../models/Client');
const { runWithTenant, withoutTenantScope, getTenantId } = require('../utils/tenantContext');
const { seedClient } = require('./helpers');

const rfqDoc = (overrides = {}) => ({
  id: 'RFQ-2026-001',
  description: 'Bearings',
  deadlineDate: new Date(Date.now() + 86400000),
  items: [{ line: 10, materialCode: 'MAT-1', quantity: 5 }],
  ...overrides,
});

describe('tenant plugin — unbound queries', () => {
  it('throws instead of reading every tenant when no context is bound', async () => {
    await expect(RFQ.find({})).rejects.toThrow(/Tenant context missing/);
    await expect(RFQ.findOne({ id: 'RFQ-2026-001' })).rejects.toThrow(/Tenant context missing/);
    await expect(RFQ.countDocuments({})).rejects.toThrow(/Tenant context missing/);
  });

  it('throws instead of writing without a tenant', async () => {
    await expect(RFQ.create(rfqDoc())).rejects.toThrow(/Tenant context missing/);
    await expect(RFQ.updateMany({}, { $set: { status: 'Closed' } })).rejects.toThrow(/Tenant context missing/);
    await expect(RFQ.deleteMany({})).rejects.toThrow(/Tenant context missing/);
  });

  it('throws on an unbound aggregate', async () => {
    await expect(RFQ.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]))
      .rejects.toThrow(/Tenant context missing/);
  });
});

describe('tenant plugin — bound queries', () => {
  it('stamps clientId on create without the caller passing it', async () => {
    const rfq = await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc()));
    expect(rfq.clientId).toBe('CLT-0001');
  });

  it('ignores a caller-supplied clientId and uses the bound tenant', async () => {
    const rfq = await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc({ clientId: 'CLT-9999' })));
    expect(rfq.clientId).toBe('CLT-0001');
  });

  it('cannot move a document to another tenant via update', async () => {
    await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc()));
    await runWithTenant('CLT-0001', () => RFQ.updateOne({ id: 'RFQ-2026-001' }, { $set: { clientId: 'CLT-9999' } }));

    const stillOurs = await runWithTenant('CLT-0001', () => RFQ.findOne({ id: 'RFQ-2026-001' }));
    expect(stillOurs.clientId).toBe('CLT-0001');
  });

  it('scopes reads to the bound tenant', async () => {
    await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc()));
    await runWithTenant('CLT-0002', () => RFQ.create(rfqDoc({ description: 'Other tenant bearings' })));

    const mine = await runWithTenant('CLT-0001', () => RFQ.find({}));
    expect(mine).toHaveLength(1);
    expect(mine[0].description).toBe('Bearings');
  });

  it('scopes aggregates to the bound tenant', async () => {
    await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc()));
    await runWithTenant('CLT-0002', () => RFQ.create(rfqDoc()));

    const rows = await runWithTenant('CLT-0002', () => RFQ.aggregate([{ $count: 'n' }]));
    expect(rows[0].n).toBe(1);
  });

  it('lets the same business ID exist in two tenants', async () => {
    await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc()));
    await expect(runWithTenant('CLT-0002', () => RFQ.create(rfqDoc()))).resolves.toBeTruthy();
  });
});

describe('withoutTenantScope', () => {
  it('reads across tenants — the deliberate platform-plane escape hatch', async () => {
    await runWithTenant('CLT-0001', () => RFQ.create(rfqDoc()));
    await runWithTenant('CLT-0002', () => RFQ.create(rfqDoc()));

    const all = await withoutTenantScope(() => RFQ.find({}));
    expect(all).toHaveLength(2);
  });

  it('does not leak its unscoped state outside the callback', async () => {
    await withoutTenantScope(() => Client.findOne({ clientId: 'CLT-0001' }));
    expect(getTenantId()).toBeNull();
    await expect(RFQ.find({})).rejects.toThrow(/Tenant context missing/);
  });

  it('keeps nested tenant work bound to the inner tenant', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'second', companyName: 'Second' });
    const vendor = await runWithTenant('CLT-0002', () => Vendor.create({
      vendorId: 'VND-NESTED', companyName: 'Nested Co',
      gstin: '29AABCN1111N1Z0', pan: 'AABCN1111N', email: 'nested@example.com',
    }));
    expect(vendor.clientId).toBe('CLT-0002');
  });
});
