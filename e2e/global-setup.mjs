import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Seeds the demo tenant and makes the mock SAP answer instantly.
//
// The job worker is NOT started here — it runs inside the API process (see
// e2e/api-server.cjs for why).

export default async function globalSetup() {
  const root = path.resolve(import.meta.dirname, '..');

  // Idempotent: seed-demo skips a tenant it has already built (pass --reset to
  // rebuild). The specs create their own tenders rather than relying on the
  // seeded documents, so a warm database is fine — what they need from this is
  // the accounts.
  execFileSync(process.execPath, ['backend/scripts/seed-demo.js'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  await zeroTheMockSapDelays(root);
}

/**
 * Gives the demo tenant a mock SAP connection whose delays are zero.
 *
 * The mock driver otherwise makes a goods receipt wait 10s and a payment run
 * 12s of wall clock (DEFAULT_TIMINGS in sap/drivers/mock.driver.js). That is
 * the right default for a demo, and poison for a test: the job that polls for
 * the receipt finds nothing on its first tick and re-polls on a 30s interval
 * (jobs/kinds.js), so the flow takes over half a minute and its duration
 * depends on where the tick lands. Zeroing the delays makes the first poll
 * succeed, which is deterministic.
 *
 * Written as a real per-tenant connection row rather than by setting
 * NODE_ENV=test (which zeroes them globally), so the servers under test stay
 * in their normal mode and the tenant-config path is the one being exercised.
 */
async function zeroTheMockSapDelays(root) {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(root, 'backend', 'package.json'));
  const { rawPrisma } = require('./db/prisma');

  const clientId = 'CLT-0001';
  const client = await rawPrisma.client.findFirst({
    where: { clientId },
    select: { sapEnvironment: true },
  });
  const environment = client?.sapEnvironment || 'sandbox';
  const config = { timings: { goodsReceiptMs: 0, paymentRunMs: 0 } };

  await rawPrisma.sapConnection.upsert({
    where: { clientId_environment: { clientId, environment } },
    create: { clientId, environment, driver: 'mock', config, createdBy: 'e2e' },
    update: { driver: 'mock', config, updatedBy: 'e2e' },
  });

  await rawPrisma.$disconnect();
}
