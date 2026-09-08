// Smoke test for the Prisma-ported parts of controllers/vendor.controller.js
// (getVendorById/getPerformance are deliberately excluded — not yet ported,
// see the comments in that file).
const assert = require('assert');
const { rawPrisma } = require('../db/prisma');
process.env.MAIL_TRANSPORT = 'log';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const {
  createProfile, createVendor, updateProfile, submitRegistration,
  approveVendor, rejectVendor, listVendors,
} = require('../controllers/vendor.controller');

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
  headers: {}, ip: '127.0.0.1', query: {}, body: {}, params: {}, ...overrides,
});
const capturedNext = () => { const fn = (err) => { fn.error = err; }; return fn; };

const resetDb = async () => {
  await rawPrisma.auditLog.deleteMany({});
  await rawPrisma.vendor.deleteMany({});
  await rawPrisma.client.deleteMany({});
};

async function main() {
  await resetDb();
  const client = await withoutTenantScope(() => rawPrisma.client.create({
    data: { clientId: 'CLT-0001', slug: 'legacy', companyName: 'Legacy', status: 'Active' },
  }));

  await test('createProfile creates a Draft vendor from a public (unauthenticated) request', async () => {
    const req = fakeReq({
      headers: { 'x-client-slug': 'legacy' },
      body: { vendorId: 'VND-11111', companyName: 'Profile Co', gstin: '27AABCB1234F1Z5', pan: 'AABCB1234F', email: 'profile@example.com' },
    });
    const res = fakeRes();
    await createProfile(req, res, capturedNext());
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.status, 'Draft');
  });

  await test('updateProfile updates fields and re-hashes a password if one is sent', async () => {
    const req = fakeReq({
      auth: { plane: 'supplier' }, scopeVendorId: 'VND-11111',
      body: { companyName: 'Profile Co Updated', password: 'newSecret1' },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => updateProfile(req, res, capturedNext()));
    assert.strictEqual(res.body.companyName, 'Profile Co Updated');
    assert.strictEqual(res.body.password, undefined);

    const stored = await withoutTenantScope(() => rawPrisma.vendor.findFirst({ where: { vendorId: 'VND-11111' }, omit: { password: false } }));
    assert.ok(stored.password.startsWith('$2'));
  });

  await test('createVendor (tenant-directory path) creates a Draft vendor with a reset token, no known password', async () => {
    const req = fakeReq({
      auth: { id: 'admin-pk', email: 'admin@legacy.test', role: 'client_admin', plane: 'tenant' },
      client, body: { companyName: 'Directory Co', gstin: '27AABCB1234F1Z6', pan: 'AABCB1234G', email: 'directory@example.com' },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => createVendor(req, res, capturedNext()));
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.vendor.status, 'Draft');
    assert.strictEqual(res.body.vendor.mustChangePassword, true);

    const stored = await withoutTenantScope(() => rawPrisma.vendor.findFirst({
      where: { email: 'directory@example.com' },
      omit: { resetPasswordToken: false, password: false },
    }));
    assert.ok(stored.password.startsWith('$2'), 'has a real (unguessable) hashed password, not a blank one');
    assert.ok(stored.resetPasswordToken, 'has a reset token so the supplier can claim the account');
  });

  await test('submitRegistration moves Draft -> Pending Approval and runs KYC verification', async () => {
    const req = fakeReq({ auth: { plane: 'supplier' }, scopeVendorId: 'VND-11111', clientId: 'CLT-0001' });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => submitRegistration(req, res, capturedNext()));
    assert.strictEqual(res.body.vendor.status, 'Pending Approval');
    assert.ok(res.body.vendor.verifiedAt);
  });

  let vendorPk;
  await test('approveVendor sets status, approvedAt and a sapVendorCode', async () => {
    const vendor = await withoutTenantScope(() => rawPrisma.vendor.findFirst({ where: { vendorId: 'VND-11111' } }));
    vendorPk = vendor.pk;
    const req = fakeReq({
      auth: { id: 'admin-pk', email: 'admin@legacy.test', role: 'client_admin', plane: 'tenant' },
      client, clientId: 'CLT-0001', params: { id: vendorPk },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => approveVendor(req, res, capturedNext()));
    assert.strictEqual(res.body.vendor.status, 'Approved');
    assert.ok(res.body.vendor.sapVendorCode);
  });

  await test('rejectVendor on a second vendor sets status and rejectionReason', async () => {
    const vendor = await withoutTenantScope(() => rawPrisma.vendor.findFirst({ where: { email: 'directory@example.com' } }));
    const req = fakeReq({
      auth: { id: 'admin-pk', email: 'admin@legacy.test', role: 'client_admin', plane: 'tenant' },
      client, clientId: 'CLT-0001', params: { id: vendor.pk }, body: { reason: 'Incomplete documents' },
    });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => rejectVendor(req, res, capturedNext()));
    assert.strictEqual(res.body.vendor.status, 'Rejected');
    assert.strictEqual(res.body.vendor.rejectionReason, 'Incomplete documents');
  });

  await test('listVendors filters by status and case-insensitive search', async () => {
    const req = fakeReq({ query: { status: 'Approved' } });
    const res = fakeRes();
    await runWithTenant('CLT-0001', () => listVendors(req, res, capturedNext()));
    assert.strictEqual(res.body.vendors.length, 1);
    assert.strictEqual(res.body.vendors[0].companyName, 'Profile Co Updated');

    const req2 = fakeReq({ query: { search: 'DIRECTORY' } });
    const res2 = fakeRes();
    await runWithTenant('CLT-0001', () => listVendors(req2, res2, capturedNext()));
    assert.strictEqual(res2.body.vendors.length, 1);
    assert.strictEqual(res2.body.vendors[0].email, 'directory@example.com');
  });

  await test('listVendors rejects an unknown status', async () => {
    const req = fakeReq({ query: { status: 'NotAStatus' } });
    const res = fakeRes();
    const next = capturedNext();
    await runWithTenant('CLT-0001', () => listVendors(req, res, next));
    assert.strictEqual(next.error?.statusCode, 400);
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
