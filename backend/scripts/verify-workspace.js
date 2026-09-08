// Smoke test for user.controller.js + workspace.controller.js's Prisma port,
// especially the settings round-trip (branding.* now maps to flat scalar
// columns instead of a nested Mongoose subdocument — see config/tenantSettings.js).
const assert = require('assert');
const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');

const { listUsers, updateUser, setUserStatus } = require('../controllers/user.controller');
const { getOverview, getSettings, updateSettings, listAudit } = require('../controllers/workspace.controller');

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

const fakeRes = () => {
  const res = { statusCode: 200 };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};
const fakeReq = (overrides = {}) => ({
  auth: { id: 'me', email: 'me@legacy.test', role: 'client_admin', plane: 'tenant' },
  query: {}, body: {}, params: {}, ...overrides,
});
const capturedNext = () => { const fn = (err) => { fn.error = err; }; return fn; };

const resetDb = async () => {
  await rawPrisma.auditLog.deleteMany({});
  await rawPrisma.user.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.client.deleteMany({});
};

async function main() {
  await resetDb();
  let client = await withoutTenantScope(() => rawPrisma.client.create({
    data: { clientId: 'CLT-0001', slug: 'legacy', companyName: 'Legacy', status: 'Active' },
  }));

  let admin, staff;
  await runWithTenant('CLT-0001', async () => {
    admin = await prisma.user.create({ data: { email: 'admin@legacy.test', name: 'Admin', role: 'client_admin', status: 'Active' } });
    staff = await prisma.user.create({ data: { email: 'staff@legacy.test', name: 'Staff', role: 'finance', status: 'Active' } });
  });

  await test('listUsers returns this tenant\'s staff', async () => {
    const req = fakeReq();
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => listUsers(req, res));
    assert.strictEqual(res.body.users.length, 2);
  });

  await test('updateUser demoting the only admin is blocked', async () => {
    const req = fakeReq({ params: { id: admin.pk }, body: { role: 'finance' } });
    const res = fakeRes();
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => updateUser(req, res, next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('setUserStatus cannot suspend yourself', async () => {
    const req = fakeReq({ auth: { id: admin.pk, plane: 'tenant' }, params: { id: admin.pk }, body: { status: 'Suspended' } });
    const res = fakeRes();
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => setUserStatus(req, res, next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('setUserStatus suspends a non-admin staff member', async () => {
    const req = fakeReq({ params: { id: staff.pk }, body: { status: 'Suspended' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => setUserStatus(req, res, capturedNext()));
    assert.strictEqual(res.body.user.status, 'Suspended');
  });

  await test('getOverview counts staff/suppliers/etc for the bound tenant', async () => {
    const req = fakeReq({ client });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => getOverview(req, res));
    assert.strictEqual(res.body.staff.active, 1, 'only the admin is still Active after suspending staff');
    assert.strictEqual(res.body.suppliers.total, 0);
  });

  await test('getSettings reads defaults before anything is configured', async () => {
    const req = fakeReq({ client });
    const res = fakeRes();
    await getSettings(req, res);
    const branding = res.body.groups.find((g) => g.key === 'branding');
    const logo = branding.settings.find((s) => s.key === 'branding.logo');
    assert.strictEqual(logo.value, '', 'default logo is empty string');
  });

  await test('updateSettings persists a branding.logo change to the flat brandingLogo column', async () => {
    const req = fakeReq({ client, body: { settings: { 'branding.logo': 'https://example.com/logo.png' } } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => updateSettings(req, res, capturedNext()));
    assert.deepStrictEqual(res.body.changed, ['branding.logo']);
    assert.strictEqual(res.body.workspace.branding.logo, 'https://example.com/logo.png');

    const stored = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } }));
    assert.strictEqual(stored.brandingLogo, 'https://example.com/logo.png');
    client = stored;
  });

  await test('updateSettings persists a JSON-column (thresholds) change without clobbering siblings', async () => {
    const req1 = fakeReq({ client, body: { settings: { 'thresholds.invoiceReviewAmount': 999999 } } });
    const res1 = fakeRes();
    await runWithTenant('CLT-0001', () => updateSettings(req1, res1, capturedNext()));
    client = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } }));

    const req2 = fakeReq({ client, body: { settings: { 'thresholds.supplierApprovalSlaHours': 12 } } });
    const res2 = fakeRes();
    await runWithTenant('CLT-0001', () => updateSettings(req2, res2, capturedNext()));

    assert.strictEqual(res2.body.workspace.status, 'Active');
    const stored = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } }));
    assert.strictEqual(stored.settings.thresholds.invoiceReviewAmount, 999999, 'earlier threshold change must survive');
    assert.strictEqual(stored.settings.thresholds.supplierApprovalSlaHours, 12);
  });

  await test('updateSettings rejects an unknown key', async () => {
    const req = fakeReq({ client, body: { settings: { 'not.a.real.setting': true } } });
    const res = fakeRes();
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => updateSettings(req, res, next));
    assert.strictEqual(next.error?.statusCode, 400);
  });

  await test('listAudit returns this tenant\'s settings-change entries', async () => {
    const req = fakeReq({ query: {} });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => listAudit(req, res));
    assert.ok(res.body.entries.some((e) => e.action === 'settings.updated'));
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
