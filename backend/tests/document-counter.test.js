// utils/nextSequentialId.js used to select every row whose id started with the
// prefix, pull them into Node and scan in JavaScript — O(n) in the tenant's
// document count, inside the caller's transaction on the award path, and with
// the read and the write far enough apart that a background sweep and a
// concurrent award could compute the same number. These cases pin the three
// properties that replaced it: constant cost, distinct numbers under
// concurrency, and a counter that starts past whatever is already there.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { nextSequentialId } = require('../utils/nextSequentialId');
const { seedClient, createTenantUser, registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();
const year = new Date().getFullYear();
const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const counters = () => withoutTenantScope(() => rawPrisma.documentCounter.findMany({
  orderBy: [{ clientId: 'asc' }, { prefix: 'asc' }],
}));

const seedRfqs = (ids, clientId = 'CLT-0001') => runWithTenant(clientId, () => prisma.rFQ.createMany({
  data: ids.map((id) => ({ id, description: 'seed', deadlineDate: new Date(futureDate()) })),
}));

beforeEach(() => seedClient());

describe('allocation cost', () => {
  it('touches the counter once and never reads the document table in steady state', async () => {
    await seedRfqs([`RFQ-${year}-001`]);

    // First allocation seeds the counter: it is allowed to look at the
    // existing rows once, to start past them.
    await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    const spy = jest.spyOn(prisma, '$queryRaw');
    try {
      const id = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

      expect(id).toBe(`RFQ-${year}-003`);
      // One statement, whatever the tenant's document count — the property the
      // old scan could not offer.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('costs the same with 500 existing documents as with one', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `RFQ-${year}-${String(i + 1).padStart(3, '0')}`);
    await seedRfqs(many);

    await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    const spy = jest.spyOn(prisma, '$queryRaw');
    try {
      const id = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

      expect(id).toBe(`RFQ-${year}-502`);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('concurrent allocation', () => {
  it('hands out distinct numbers to allocators racing on an existing counter', async () => {
    await runWithTenant('CLT-0001', () => nextSequentialId('purchaseOrder', `PO-${year}-`, 4));

    const ids = await Promise.all(Array.from({ length: 20 }, () =>
      runWithTenant('CLT-0001', () => nextSequentialId('purchaseOrder', `PO-${year}-`, 4))));

    expect(new Set(ids).size).toBe(20);
  });

  it('hands out distinct numbers when several allocators seed the counter at once', async () => {
    // The seeding path is the one with two statements, so it is the one where
    // a lost race would show up as a duplicate.
    const ids = await Promise.all(Array.from({ length: 10 }, () =>
      runWithTenant('CLT-0001', () => nextSequentialId('purchaseOrder', `PO-${year}-`, 4))));

    expect(new Set(ids).size).toBe(10);
    expect(ids).toContain(`PO-${year}-0001`);
  });

  it('keeps tenants on separate counters', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'other', companyName: 'Other Ltd' });

    const a = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));
    const b = await runWithTenant('CLT-0002', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    expect(a).toBe(`RFQ-${year}-001`);
    expect(b).toBe(`RFQ-${year}-001`);
    expect((await counters()).map((row) => row.clientId)).toEqual(['CLT-0001', 'CLT-0002']);
  });

  it('refuses to allocate with no tenant bound', async () => {
    await expect(nextSequentialId('rFQ', `RFQ-${year}-`, 3)).rejects.toThrow(/without a bound tenant/);
  });
});

// The scenario the issue names: a discovery sweep minting a PO id outside any
// transaction while an award mints one inside its own. Both used to be able to
// compute the same number, with the loser failing on a unique constraint.
describe('an award and a discovery sweep allocating at the same time', () => {
  it('produce distinct purchase order ids', async () => {
    const vendorId = 'vendor_counter_race';
    const supplier = await registerVendor(app, { vendorId, email: 'race@example.com' }, { onboarded: true });
    const buyer = await createTenantUser({ role: 'buyer', email: 'buyer-race@example.com' });
    const asSupplier = (req) => req.set('Authorization', `Bearer ${supplier.token}`);
    const asBuyer = (req) => req.set('Authorization', `Bearer ${buyer.token}`);

    const rfq = (await asBuyer(request(app).post('/api/rfqs')).send({
      description: 'Race against a sweep',
      deadlineDate: futureDate(),
      items: [{ line: 10, materialCode: 'MAT-001', description: 'Widget', quantity: 1, targetPrice: 1 }],
      invitedVendors: [{ id: vendorId, name: 'Supplier' }],
    })).body;

    await asSupplier(request(app).post(`/api/rfqs/${rfq.id}/bid`)).send({
      unitPrices: { 10: 1 }, gstRate: '18%', deliveryLeadTimeDays: 5, validityDate: futureDate(30), freight: 0,
    });

    // The award runs its allocation inside a transaction; the sweep's runs
    // outside one, exactly as jobs/handlers/sweepPurchaseOrders.js does.
    const [award, sweptId] = await Promise.all([
      asBuyer(request(app).post(`/api/rfqs/${rfq.id}/award`)).send({ vendorId }),
      runWithTenant('CLT-0001', () => nextSequentialId('purchaseOrder', `PO-${year}-`, 4)),
    ]);

    expect(award.status).toBe(200);
    expect(award.body.po.id).not.toBe(sweptId);
  });
});

describe('starting past ids the counter did not allocate', () => {
  it('seeds past rows that predate the counter, comparing suffixes numerically', async () => {
    // Past the 3-digit padding: a string sort would call '999' the maximum.
    await seedRfqs([`RFQ-${year}-999`, `RFQ-${year}-1000`]);

    const id = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    expect(id).toBe(`RFQ-${year}-1001`);
  });

  it('ignores another tenant\'s documents when seeding', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'other', companyName: 'Other Ltd' });
    await seedRfqs([`RFQ-${year}-700`], 'CLT-0002');

    const id = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    expect(id).toBe(`RFQ-${year}-001`);
  });

  it('keeps a separate counter per year, so January starts again at 1', async () => {
    await seedRfqs([`RFQ-${year - 1}-880`]);

    const id = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    expect(id).toBe(`RFQ-${year}-001`);
  });
});

// The migration's backfill is what stops the first allocation on an existing
// deployment from colliding with documents already there. The statements are
// read out of the migration file itself rather than copied, so the test cannot
// drift away from what actually ships.
describe('the backfill in the document_counters migration', () => {
  const MIGRATION = path.join(
    __dirname, '..', 'prisma', 'migrations', '20260912000000_document_counters', 'migration.sql'
  );

  const backfillStatements = () => fs.readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.toUpperCase().startsWith('INSERT INTO "DOCUMENT_COUNTERS"'));

  const runBackfill = async () => {
    // The table is created by migrate deploy before the suite runs; this
    // re-runs only the data half against rows seeded here.
    await withoutTenantScope(() => rawPrisma.documentCounter.deleteMany({}));
    for (const statement of backfillStatements()) {
      await rawPrisma.$executeRawUnsafe(statement);
    }
  };

  it('reads both document tables', () => {
    expect(backfillStatements()).toHaveLength(2);
  });

  it('seeds each tenant and prefix past its highest existing suffix', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'other', companyName: 'Other Ltd' });
    await seedRfqs([`RFQ-${year}-001`, `RFQ-${year}-999`, `RFQ-${year}-1000`]);
    await seedRfqs([`RFQ-${year}-004`], 'CLT-0002');
    await asTenant(() => prisma.purchaseOrder.createMany({
      data: [{ id: `PO-${year}-9999`, vendorId: 'v1' }, { id: `PO-${year}-10000`, vendorId: 'v1' }],
    }));

    await runBackfill();

    expect((await counters()).map((row) => ({
      clientId: row.clientId, prefix: row.prefix, nextValue: Number(row.nextValue),
    }))).toEqual([
      { clientId: 'CLT-0001', prefix: `PO-${year}-`, nextValue: 10001 },
      { clientId: 'CLT-0001', prefix: `RFQ-${year}-`, nextValue: 1001 },
      { clientId: 'CLT-0002', prefix: `RFQ-${year}-`, nextValue: 5 },
    ]);
  });

  it('leaves the first allocation after it clear of every existing id', async () => {
    await seedRfqs([`RFQ-${year}-001`, `RFQ-${year}-1000`]);
    await runBackfill();

    const id = await runWithTenant('CLT-0001', () => nextSequentialId('rFQ', `RFQ-${year}-`, 3));

    expect(id).toBe(`RFQ-${year}-1001`);
  });

  it('writes no counter for a tenant with no documents yet', async () => {
    await runBackfill();
    expect(await counters()).toEqual([]);
  });
});
