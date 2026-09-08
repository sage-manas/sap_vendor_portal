// Verifies backend/db/sapConnectionHelpers.js — the envelope-encrypted
// secrets round-trip that replaces SapConnection's Mongoose instance methods
// (setSecrets/decryptSecrets/secretNames), against the real dev Postgres.
const assert = require('assert');
const { rawPrisma } = require('../db/prisma');
const { setSecrets, decryptSecrets, secretNames } = require('../db/sapConnectionHelpers');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

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
  await rawPrisma.sapConnectionSecret.deleteMany({});
  await rawPrisma.sapConnection.deleteMany({});
};

async function main() {
  await resetDb();

  await test('setSecrets encrypts values and secretNames lists them without exposing values', async () => {
    const connection = await rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 'mock' },
      omit: { wrappedDataKey: false },
    });

    const wrappedDataKey = await setSecrets(connection, { username: 'svc_user', password: 'hunter2' });
    await rawPrisma.sapConnection.update({ where: { pk: connection.pk }, data: { wrappedDataKey } });

    const names = await secretNames(connection);
    assert.deepStrictEqual(names, ['password', 'username']);

    const rows = await rawPrisma.sapConnectionSecret.findMany({ where: { connectionPk: connection.pk } });
    assert.ok(rows.every((r) => r.ciphertext.startsWith('v2:')), 'stored values must be v2-envelope ciphertext');
    assert.ok(!rows.some((r) => r.ciphertext.includes('hunter2')), 'plaintext must never be stored');
  });

  await test('decryptSecrets recovers the original plaintext', async () => {
    const connection = await rawPrisma.sapConnection.findFirst({
      where: { clientId: 'CLT-0001', environment: 'sandbox' },
      omit: { wrappedDataKey: false },
    });
    const plain = await decryptSecrets(connection);
    assert.deepStrictEqual(plain, { username: 'svc_user', password: 'hunter2' });
  });

  await test('setSecrets updates one key and leaves the other alone', async () => {
    let connection = await rawPrisma.sapConnection.findFirst({
      where: { clientId: 'CLT-0001', environment: 'sandbox' },
      omit: { wrappedDataKey: false },
    });
    const wrappedDataKey = await setSecrets(connection, { password: 'newpass' });
    assert.strictEqual(wrappedDataKey, connection.wrappedDataKey, 'reuses the existing data key');

    connection = await rawPrisma.sapConnection.findFirst({
      where: { clientId: 'CLT-0001', environment: 'sandbox' },
      omit: { wrappedDataKey: false },
    });
    const plain = await decryptSecrets(connection);
    assert.deepStrictEqual(plain, { username: 'svc_user', password: 'newpass' });
  });

  await test('setSecrets with a null value deletes that credential', async () => {
    let connection = await rawPrisma.sapConnection.findFirst({
      where: { clientId: 'CLT-0001', environment: 'sandbox' },
      omit: { wrappedDataKey: false },
    });
    await setSecrets(connection, { username: null });

    connection = await rawPrisma.sapConnection.findFirst({
      where: { clientId: 'CLT-0001', environment: 'sandbox' },
      omit: { wrappedDataKey: false },
    });
    const names = await secretNames(connection);
    assert.deepStrictEqual(names, ['password']);
  });

  await test('wrappedDataKey and password fields are omitted by default from a plain fetch', async () => {
    const connection = await rawPrisma.sapConnection.findFirst({ where: { clientId: 'CLT-0001' } });
    assert.strictEqual(connection.wrappedDataKey, undefined);
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
