#!/usr/bin/env node
//
// Create the test database if it does not exist, then apply migrations to it.
//
// The test suites refuse to run against the development database (issue #107),
// so there has to be a one-command way to produce the one they do use.
// Idempotent: safe to re-run, and safe to run before every suite in CI.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { execFileSync } = require('child_process');
const { resolveTestDatabaseUrl, assertSafeToWipe } = require('../config/testDatabase');

const log = (...args) => console.log('[setup-test-db]', ...args);

const main = async () => {
  const testUrl = assertSafeToWipe(resolveTestDatabaseUrl(), 'setup-test-db');
  const parsed = new URL(testUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');

  // Connect to the server's default database to issue CREATE DATABASE — you
  // cannot create a database from inside itself.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';

  // Prisma rather than `pg`: this repo has no direct Postgres driver
  // dependency and this script is not worth adding one for.
  const { PrismaClient } = require('@prisma/client');
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const existing = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname = ${databaseName}`;
    if (existing.length) {
      log(`database "${databaseName}" already exists`);
    } else {
      // CREATE DATABASE takes no bind parameters and cannot run inside a
      // transaction, so this is $executeRawUnsafe with the identifier quoted
      // by hand. The name comes from our own URL parsing, not user input.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
      log(`created database "${databaseName}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  log('applying migrations...');
  // Prisma's CLI entrypoint under this node, rather than `npx` through a
  // shell: `shell: true` is deprecated for argument passing (DEP0190) and
  // spawning `npx.cmd` without one is EINVAL on Windows.
  const prismaCli = require.resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: require('path').join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
  log(`ready: ${databaseName}`);
};

main().catch((error) => {
  console.error('[setup-test-db]', error.message);
  process.exit(1);
});
