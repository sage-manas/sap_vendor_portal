// Smoke test for the Prisma port of services/tenantProvisioning.service.js —
// exercises provisionTenant end-to-end (Client + first User admin) and
// reissueAdminCredentials, against the real dev Postgres.
const assert = require('assert');
const { rawPrisma } = require('../db/prisma');
const { comparePassword } = require('../db/credentials');
const {
  provisionTenant,
  reissueAdminCredentials,
  nextClientId,
  assertSlugAvailable,
} = require('../services/tenantProvisioning.service');

// Provisioning sends real email — force the log transport so this script
// doesn't need SMTP configured.
process.env.MAIL_TRANSPORT = 'log';

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
  await rawPrisma.client.deleteMany({});
};

async function main() {
  await resetDb();

  await test('nextClientId starts at CLT-0001 on an empty table', async () => {
    const id = await nextClientId();
    assert.strictEqual(id, 'CLT-0001');
  });

  await test('provisionTenant creates a Client + a client_admin User with a hashed password', async () => {
    const { client, clientAdmin } = await provisionTenant({
      companyName: 'Acme Ltd',
      slug: 'acme',
      admin: { email: 'admin@acme.test', name: 'Admin' },
      limits: { vendors: 10, rfqsPerMonth: 5, storageMb: 512 },
      branding: { logo: 'logo.png', primaryColor: '#111' },
      createdBy: 'script',
    });
    assert.strictEqual(client.clientId, 'CLT-0001');
    assert.strictEqual(client.limitVendors, 10);
    assert.strictEqual(client.brandingLogo, 'logo.png');
    assert.strictEqual(clientAdmin.role, 'client_admin');
    assert.strictEqual(clientAdmin.mustChangePassword, true);

    const stored = await rawPrisma.user.findFirst({ where: { pk: clientAdmin.pk }, omit: { password: false } });
    assert.ok(stored.password && stored.password.startsWith('$2'), 'password should be bcrypt-hashed');
  });

  await test('nextClientId increments after a tenant exists', async () => {
    const id = await nextClientId();
    assert.strictEqual(id, 'CLT-0002');
  });

  await test('assertSlugAvailable rejects a taken slug', async () => {
    let threw = false;
    try {
      await assertSlugAvailable('acme');
    } catch (err) {
      threw = true;
      assert.match(err.message, /already taken/);
    }
    assert.ok(threw);
  });

  await test('reissueAdminCredentials rotates the password and sets mustChangePassword', async () => {
    const client = await rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } });
    const admin = await rawPrisma.user.findFirst({ where: { clientId: 'CLT-0001' } });
    const before = await rawPrisma.user.findFirst({ where: { pk: admin.pk }, omit: { password: false } });

    await reissueAdminCredentials({ client, userId: admin.pk });

    const after = await rawPrisma.user.findFirst({ where: { pk: admin.pk }, omit: { password: false } });
    assert.notStrictEqual(after.password, before.password);
    assert.strictEqual(after.mustChangePassword, true);
  });

  await test('comparePassword works against a freshly hashed password', async () => {
    const { hashPassword } = require('../db/credentials');
    const { password } = await hashPassword('correct-horse');
    assert.strictEqual(await comparePassword('correct-horse', password), true);
    assert.strictEqual(await comparePassword('wrong', password), false);
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
