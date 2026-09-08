// Phase 0 verification: proves backend/db/tenantExtension.js and
// appendOnlyExtension.js behave the same way models/plugins/tenantPlugin.js
// and AuditLog/SapConnectionAudit's throwing hooks do today, before any
// controller is ported. Mirrors the assertions in
// backend/tests/tenant-plugin.test.js one-for-one, but runs directly against
// a real Postgres (this repo's docker-compose service) rather than jest's
// mongodb-memory-server setup, since that setup is Mongo-specific and the
// full suite port to Postgres is a later phase.
//
// Run with: node scripts/verify-tenant-extension.js
// Requires: docker compose up -d postgres && npx prisma migrate deploy

const assert = require('assert');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope, getTenantId } = require('../utils/tenantContext');

let passed = 0;
let failed = 0;

const rejects = async (promise, pattern) => {
  try {
    await promise;
  } catch (err) {
    assert.match(err.message, pattern, `expected error matching ${pattern}, got: ${err.message}`);
    return;
  }
  throw new Error('expected rejection, but resolved');
};

const rfqData = (overrides = {}) => ({
  id: 'RFQ-2026-001',
  description: 'Bearings',
  deadlineDate: new Date(Date.now() + 86400000),
  ...overrides,
});

// Mirrors jest's afterEach: wipe everything so each test starts from a clean,
// re-seeded slate (two clients, no RFQs/audit rows).
const resetDb = async () => {
  await rawPrisma.rfqBidUnitPrice.deleteMany({});
  await rawPrisma.rfqBidDocument.deleteMany({});
  await rawPrisma.rfqBid.deleteMany({});
  await rawPrisma.rfqInvitedVendor.deleteMany({});
  await rawPrisma.rfqItem.deleteMany({});
  await rawPrisma.rFQ.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.auditLog.deleteMany({});
  await rawPrisma.client.deleteMany({});
  await rawPrisma.client.createMany({
    data: [
      { clientId: 'CLT-0001', slug: 'legacy', companyName: 'Legacy' },
      { clientId: 'CLT-0002', slug: 'second', companyName: 'Second' },
    ],
  });
};

const test = async (name, fn) => {
  await resetDb();
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
  }
};

async function main() {
  console.log('tenant extension — unbound queries');
  await test('throws instead of reading every tenant when no context is bound', async () => {
    await rejects(prisma.rFQ.findMany({}), /Tenant context missing/);
    await rejects(prisma.rFQ.findFirst({ where: { id: 'RFQ-2026-001' } }), /Tenant context missing/);
    await rejects(prisma.rFQ.count({}), /Tenant context missing/);
  });

  await test('throws instead of writing without a tenant', async () => {
    await rejects(prisma.rFQ.create({ data: rfqData() }), /Tenant context missing/);
    await rejects(prisma.rFQ.updateMany({ where: {}, data: { status: 'Closed' } }), /Tenant context missing/);
    await rejects(prisma.rFQ.deleteMany({ where: {} }), /Tenant context missing/);
  });

  await test('throws on an unbound aggregate/groupBy', async () => {
    await rejects(prisma.rFQ.groupBy({ by: ['status'], _count: true }), /Tenant context missing/);
  });

  console.log('tenant extension — bound queries');
  await test('stamps clientId on create without the caller passing it', async () => {
    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    assert.strictEqual(rfq.clientId, 'CLT-0001');
  });

  await test('ignores a caller-supplied clientId and uses the bound tenant', async () => {
    const rfq = await runWithTenant('CLT-0001', () =>
      prisma.rFQ.create({ data: rfqData({ clientId: 'CLT-9999' }) })
    );
    assert.strictEqual(rfq.clientId, 'CLT-0001');
  });

  await test('cannot move a document to another tenant via update', async () => {
    await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    await runWithTenant('CLT-0001', () =>
      prisma.rFQ.updateMany({ where: { id: 'RFQ-2026-001' }, data: { clientId: 'CLT-9999' } })
    );
    const stillOurs = await runWithTenant('CLT-0001', () =>
      prisma.rFQ.findFirst({ where: { id: 'RFQ-2026-001' } })
    );
    assert.strictEqual(stillOurs.clientId, 'CLT-0001');
  });

  await test('scopes reads to the bound tenant', async () => {
    await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    await runWithTenant('CLT-0002', () =>
      prisma.rFQ.create({ data: rfqData({ description: 'Other tenant bearings' }) })
    );
    const mine = await runWithTenant('CLT-0001', () => prisma.rFQ.findMany({}));
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(mine[0].description, 'Bearings');
  });

  await test('scopes groupBy to the bound tenant', async () => {
    await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    await runWithTenant('CLT-0002', () => prisma.rFQ.create({ data: rfqData() }));
    const rows = await runWithTenant('CLT-0002', () =>
      prisma.rFQ.groupBy({ by: ['status'], _count: true })
    );
    const total = rows.reduce((sum, r) => sum + r._count, 0);
    assert.strictEqual(total, 1);
  });

  await test('lets the same business ID exist in two tenants', async () => {
    await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    const dup = await runWithTenant('CLT-0002', () => prisma.rFQ.create({ data: rfqData() }));
    assert.ok(dup);
  });

  await test('findUnique on a tenant-scoped model respects the bound tenant', async () => {
    await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    const found = await runWithTenant('CLT-0001', () =>
      prisma.rFQ.findUnique({ where: { clientId_id: { clientId: 'CLT-9999', id: 'RFQ-2026-001' } } })
    );
    // The compound key's own clientId is overridden by the bound tenant, so
    // this must resolve CLT-0001's row rather than fail or leak CLT-9999's.
    assert.strictEqual(found.clientId, 'CLT-0001');
  });

  await test('findUnique returns null for a row belonging to another tenant', async () => {
    const vendor = await runWithTenant('CLT-0002', () =>
      prisma.vendor.create({
        data: {
          vendorId: 'VND-X', companyName: 'X Co', gstin: '29AABCX1111N1Z0',
          pan: 'AABCX1111N', email: 'x@example.com',
        },
      })
    );
    const seenFromWrongTenant = await runWithTenant('CLT-0001', () =>
      prisma.vendor.findUnique({ where: { pk: vendor.pk } })
    );
    assert.strictEqual(seenFromWrongTenant, null);
  });

  await test('update by bare pk cannot touch another tenant\'s row', async () => {
    const mine = await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    const theirs = await runWithTenant('CLT-0002', () => prisma.rFQ.create({ data: rfqData() }));

    await rejects(
      runWithTenant('CLT-0001', () =>
        prisma.rFQ.update({ where: { pk: theirs.pk }, data: { description: 'pwned' } })
      ),
      /No RFQ found/
    );

    const updated = await runWithTenant('CLT-0001', () =>
      prisma.rFQ.update({ where: { pk: mine.pk }, data: { description: 'updated' } })
    );
    assert.strictEqual(updated.description, 'updated');
  });

  await test('delete by bare pk cannot touch another tenant\'s row', async () => {
    const theirs = await runWithTenant('CLT-0002', () => prisma.rFQ.create({ data: rfqData() }));

    await rejects(
      runWithTenant('CLT-0001', () => prisma.rFQ.delete({ where: { pk: theirs.pk } })),
      /No RFQ found/
    );

    const stillThere = await withoutTenantScope(() => rawPrisma.rFQ.findFirst({ where: { pk: theirs.pk } }));
    assert.ok(stillThere);
  });

  await test('update cannot move a row to another tenant via data.clientId', async () => {
    const mine = await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    const updated = await runWithTenant('CLT-0001', () =>
      prisma.rFQ.update({ where: { pk: mine.pk }, data: { clientId: 'CLT-9999' } })
    );
    assert.strictEqual(updated.clientId, 'CLT-0001');
  });

  await test('upsert with a forged clientId in the compound key still lands on the bound tenant', async () => {
    const upserted = await runWithTenant('CLT-0001', () =>
      prisma.rFQ.upsert({
        where: { clientId_id: { clientId: 'CLT-9999', id: 'RFQ-2026-001' } },
        create: rfqData(),
        update: { description: 'should not run — no existing row' },
      })
    );
    assert.strictEqual(upserted.clientId, 'CLT-0001');
  });

  console.log('withoutTenantScope');
  await test('reads across tenants — the deliberate platform-plane escape hatch', async () => {
    await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));
    await runWithTenant('CLT-0002', () => prisma.rFQ.create({ data: rfqData() }));
    const all = await withoutTenantScope(() => prisma.rFQ.findMany({}));
    assert.strictEqual(all.length, 2);
  });

  await test('does not leak its unscoped state outside the callback', async () => {
    await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } }));
    assert.strictEqual(getTenantId(), null);
    await rejects(prisma.rFQ.findMany({}), /Tenant context missing/);
  });

  console.log('transactions (Phase 3 — schedulePaymentRun / submitASN rely on this)');
  await test('a mid-transaction failure rolls back every write made through the extended client', async () => {
    const rfq = await runWithTenant('CLT-0001', () => prisma.rFQ.create({ data: rfqData() }));

    await rejects(
      prisma.$transaction(async (tx) => {
        return runWithTenant('CLT-0001', async () => {
          await tx.rFQ.update({ where: { pk: rfq.pk }, data: { description: 'should be rolled back' } });
          await tx.rFQ.create({ data: rfqData({ id: 'RFQ-2026-999' }) }); // duplicate-free, succeeds
          // Force a failure after two successful writes in the same transaction.
          await tx.rFQ.update({ where: { pk: 'not-a-real-uuid-00000000-0000-0000-0000-000000000000' }, data: { description: 'x' } });
        });
      }),
      /No RFQ found|Invalid|invalid/
    );

    const unchanged = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { pk: rfq.pk } }));
    assert.strictEqual(unchanged.description, 'Bearings', 'the update inside the failed transaction must not have persisted');

    const neverCreated = await runWithTenant('CLT-0001', () => prisma.rFQ.findFirst({ where: { id: 'RFQ-2026-999' } }));
    assert.strictEqual(neverCreated, null, 'the create inside the failed transaction must not have persisted either');
  });

  console.log('append-only extension');
  await test('throws on AuditLog update/delete, allows create/read', async () => {
    const entry = await withoutTenantScope(() =>
      prisma.auditLog.create({
        data: { actorId: 'script', actorRole: 'system', plane: 'system', action: 'test.action' },
      })
    );
    await rejects(
      prisma.auditLog.update({ where: { pk: entry.pk }, data: { actorRole: 'changed' } }),
      /append-only/
    );
    await rejects(prisma.auditLog.delete({ where: { pk: entry.pk } }), /append-only/);
    const stillThere = await prisma.auditLog.findUnique({ where: { pk: entry.pk } });
    assert.ok(stillThere);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  await resetDb();
  await rawPrisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await rawPrisma.$disconnect();
  process.exit(1);
});
