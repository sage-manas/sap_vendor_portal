/**
 * Runs testConnection() against Nucleus Manufacturing's saved sandbox SAP
 * connection, the same call POST /api/platform/tenants/:clientId/sap/:environment/test
 * makes, and writes the result back onto SapConnection.lastTest so the
 * platform console's own screen reflects it too.
 *
 *   node scripts/dev-test-nucleus-sap.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { rawPrisma: prisma } = require('../db/prisma');
const { decryptSecrets } = require('../db/sapConnectionHelpers');
const { buildTransientAdapter } = require('../sap');

const CLIENT_ID = 'CLT-0001';
const ENVIRONMENT = 'sandbox';

const main = async () => {
  const connection = await prisma.sapConnection.findFirst({
    where: { clientId: CLIENT_ID, environment: ENVIRONMENT },
    omit: { wrappedDataKey: false },
  });
  if (!connection) throw new Error(`no ${ENVIRONMENT} SapConnection for ${CLIENT_ID} — run dev-configure-nucleus-sap.js first`);

  const adapter = buildTransientAdapter({
    clientId: CLIENT_ID,
    driver: connection.driver,
    config: connection.config,
    secrets: await decryptSecrets(connection),
  });

  let result;
  try {
    const { ok, message, latencyMs, detail } = await adapter.testConnection();
    result = { ok, message, latencyMs, detail, driver: connection.driver };
  } catch (error) {
    result = { ok: false, message: error.message, latencyMs: null, driver: connection.driver };
  }

  const lastTest = { ...result, at: new Date(), testedBy: 'dev-script' };
  await prisma.sapConnection.update({ where: { pk: connection.pk }, data: { lastTest } });

  console.log(JSON.stringify(lastTest, null, 2));
  if (!result.ok) process.exitCode = 1;
};

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
