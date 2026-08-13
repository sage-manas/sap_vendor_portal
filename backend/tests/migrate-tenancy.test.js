// The migration is the only thing standing between the existing production
// data set and a tenancy layer that refuses untagged documents, so it is
// tested like application code.
const mongoose = require('mongoose');
const Client = require('../models/Client');
const RFQ = require('../models/RFQ');
const Vendor = require('../models/Vendor');
const { migrate } = require('../scripts/migrate-tenancy');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

// Pre-tenancy documents, written underneath Mongoose so they carry no clientId
// — exactly what the existing database looks like.
const seedLegacyData = async () => {
  await mongoose.connection.collection('rfqs').insertMany([
    { id: 'RFQ-2026-001', description: 'Old RFQ one', status: 'Bidding Open', items: [] },
    { id: 'RFQ-2026-002', description: 'Old RFQ two', status: 'Awarded', items: [] },
  ]);
  await mongoose.connection.collection('vendors').insertOne({
    vendorId: 'VND-90001', companyName: 'Incumbent Co',
    gstin: '27AABCI9999F1Z5', pan: 'AABCI9999F', email: 'incumbent@example.com',
  });
};

describe('migrate-tenancy', () => {
  beforeEach(async () => {
    // The suite-wide fixture already created CLT-0001; drop it so the
    // migration is exercised from a genuinely pre-tenancy state.
    await withoutTenantScope(() => Client.deleteMany({}));
    await seedLegacyData();
  });

  it('creates the CLT-0001 "Legacy" client and back-fills every document', async () => {
    await migrate();

    const client = await withoutTenantScope(() => Client.findOne({ clientId: 'CLT-0001' }));
    expect(client).toBeTruthy();
    expect(client.slug).toBe('legacy');
    expect(client.status).toBe('Active');

    const rfqs = await runWithTenant('CLT-0001', () => RFQ.find({}));
    expect(rfqs).toHaveLength(2);

    const vendors = await runWithTenant('CLT-0001', () => Vendor.find({}));
    expect(vendors).toHaveLength(1);
    expect(vendors[0].companyName).toBe('Incumbent Co');
  });

  it('is idempotent — a second run changes nothing', async () => {
    await migrate();
    const first = await withoutTenantScope(() => Client.find({}));

    const results = await migrate();
    expect(results.every((r) => r.migrated === 0)).toBe(true);

    const second = await withoutTenantScope(() => Client.find({}));
    expect(second).toHaveLength(first.length);
    await expect(runWithTenant('CLT-0001', () => RFQ.countDocuments({}))).resolves.toBe(2);
  });

  it('--dry-run writes nothing', async () => {
    await migrate({ dryRun: true });

    await expect(withoutTenantScope(() => Client.countDocuments({}))).resolves.toBe(0);
    const untagged = await mongoose.connection.collection('rfqs')
      .countDocuments({ clientId: { $exists: false } });
    expect(untagged).toBe(2);
  });

  it('leaves migrated data readable only inside its tenant', async () => {
    await migrate();
    await expect(runWithTenant('CLT-0002', () => RFQ.find({}))).resolves.toHaveLength(0);
  });
});
