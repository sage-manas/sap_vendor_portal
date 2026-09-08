// Smoke test for controllers/platformTenant.controller.js's Prisma port —
// exercises the handlers directly with fake req/res objects, against the
// real dev Postgres.
const assert = require('assert');
const { rawPrisma } = require('../db/prisma');
process.env.MAIL_TRANSPORT = 'log';

const {
  listTenants, getTenant, createTenant, updateTenant,
  suspendTenant, reactivateTenant, formatClient,
} = require('../controllers/platformTenant.controller');

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
};

const resetDb = async () => {
  await rawPrisma.user.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.auditLog.deleteMany({});
  await rawPrisma.client.deleteMany({});
};

// Minimal fake req/res — these controllers are asyncHandler-wrapped Express
// handlers, so calling them directly with plain objects (no server) works.
const fakeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = () => {};
  return res;
};
const fakeReq = (overrides = {}) => ({
  auth: { id: 'operator-1', email: 'op@platform.test', role: 'super_admin', plane: 'platform' },
  ip: '127.0.0.1',
  query: {},
  body: {},
  params: {},
  ...overrides,
});

async function main() {
  await resetDb();

  await test('createTenant provisions a Client + admin and returns the formatted shape', async () => {
    const req = fakeReq({
      body: {
        companyName: 'Beta Inc', slug: 'beta',
        limits: { vendors: 20, rfqsPerMonth: 40, storageMb: 2048 },
        branding: { logo: 'b.png', primaryColor: '#222' },
        admin: { email: 'admin@beta.test', name: 'Beta Admin' },
      },
    });
    const res = fakeRes();
    await createTenant(req, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.tenant.clientId, 'CLT-0001');
    assert.strictEqual(res.body.tenant.limits.vendors, 20);
    assert.strictEqual(res.body.tenant.branding.logo, 'b.png');
  });

  await test('listTenants finds it with a case-insensitive q filter', async () => {
    const req = fakeReq({ query: { q: 'BETA' } });
    const res = fakeRes();
    await listTenants(req, res);
    assert.strictEqual(res.body.total, 1);
    assert.strictEqual(res.body.tenants[0].companyName, 'Beta Inc');
  });

  await test('getTenant returns the admin and zeroed counts for a fresh tenant', async () => {
    const req = fakeReq({ params: { clientId: 'CLT-0001' } });
    const res = fakeRes();
    await getTenant(req, res);
    assert.strictEqual(res.body.administrators.length, 1);
    assert.strictEqual(res.body.administrators[0].email, 'admin@beta.test');
    assert.strictEqual(res.body.counts.Vendor, 0);
    assert.strictEqual(res.body.counts.RFQ, 0);
  });

  await test('updateTenant merges a partial limits patch without clobbering the rest', async () => {
    const req = fakeReq({ params: { clientId: 'CLT-0001' }, body: { limits: { vendors: 99 } } });
    const res = fakeRes();
    await updateTenant(req, res);
    assert.strictEqual(res.body.tenant.limits.vendors, 99);
    assert.strictEqual(res.body.tenant.limits.rfqsPerMonth, 40, 'untouched field must survive the merge');
  });

  await test('suspend then reactivate transitions the status and stamps dates', async () => {
    const suspendRes = fakeRes();
    await suspendTenant(fakeReq({ params: { clientId: 'CLT-0001' }, body: { reason: 'test' } }), suspendRes);
    assert.strictEqual(suspendRes.body.tenant.status, 'Suspended');
    assert.ok(suspendRes.body.tenant.suspendedAt);

    const reactivateRes = fakeRes();
    await reactivateTenant(fakeReq({ params: { clientId: 'CLT-0001' } }), reactivateRes);
    assert.strictEqual(reactivateRes.body.tenant.status, 'Active');
  });

  await test('an audit trail was written for create/update/suspend/reactivate', async () => {
    const entries = await rawPrisma.auditLog.findMany({ where: { clientId: 'CLT-0001' } });
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('tenant.created'), actions.join(','));
    assert.ok(actions.includes('tenant.updated'), actions.join(','));
    assert.ok(actions.includes('tenant.suspended'), actions.join(','));
    assert.ok(actions.includes('tenant.reactivated'), actions.join(','));
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
