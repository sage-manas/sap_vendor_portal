/**
 * Points Nucleus Manufacturing's SAP connection (sandbox environment) at the
 * live Z-REST gateway, using the config field names s4odata.driver.js reads
 * (sap/drivers/s4odata.driver.js configFields) and the exact base URL / paths
 * confirmed live against 103.206.131.27:8081.
 *
 * Stands in for PUT /api/platform/tenants/:clientId/sap/:environment
 * (controllers/platformSap.controller.js#configureSap) run from the platform
 * console — this local dev environment has no running platform server/token
 * to call that route over HTTP, so this writes the same SapConnection row
 * directly, then clears the cached adapter exactly as that route does.
 *
 * Does not touch SapConnectionAudit/AuditLog — those require a request
 * context (actor identity) this script doesn't have. Configure through the
 * real platform console for anything that needs an audit trail.
 *
 *   node scripts/dev-configure-nucleus-sap.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { rawPrisma: prisma } = require('../db/prisma');
const { driverDefinition } = require('../sap/drivers');
const { invalidateSapAdapter } = require('../sap');

const CLIENT_ID = 'CLT-0001'; // Nucleus Manufacturing Pvt Ltd (slug "legacy")
const ENVIRONMENT = 'sandbox'; // matches Client.sapEnvironment already set for this tenant
const DRIVER_KEY = 's4_odata'; // sap/drivers/index.js registry key (NOT the filename "s4odata")

const config = {
  baseUrl: 'http://103.206.131.27:8081',
  sapClient: '800',
  companyCode: 'SSDN',
  // Every path below is already this driver's own default — listed
  // explicitly so the connection is self-documenting rather than relying on
  // defaults silently matching.
  vendorCrPath: '/zvendor_create/VENDOR_CR',
  miroDisplayPath: '/zmiro_display/MIRO',
  paymentMethodPath: '/ZPAYM_METHOD/PAYM_METHOD',
  rfqDisplayPath: '/ZME43/ME43',
  poGrnPath: '/zpo_grn_vendor/Detail',
  quotationDisplayPath: '/ZCL_ME48/vendor',
  quotationUpdatePricePath: '/ZQUOT_NETPR/QUOT_UPDPR',
  poDetailPath: '/zpo_grn/Detail',
  invoicePlanPath: '/zinv_milestone/plan',
  invoicePlanUpdatePath: '/zinv_plan/update',
  assetPoCreatePath: '/zasset_po/create',
  assetPoDocType: 'NB',
  paymentDetailPath: '/zpayment_api/payment',
  regionCodePath: '/ZREGION_CODE/REGION',
  paymentTermsPath: '/zpaym_term/PAY_TERM',
};

const main = async () => {
  const client = await prisma.client.findFirst({ where: { clientId: CLIENT_ID } });
  if (!client) throw new Error(`no client with clientId ${CLIENT_ID}`);

  const definition = driverDefinition(DRIVER_KEY);
  // No secrets: every confirmed-live endpoint in this BAPI set accepts a
  // plain call with no Authorization header (see s4odata.driver.js's note on
  // vendorCreate). requireProductionCredentials only engages for
  // environment: 'production', so 'sandbox' with no secrets validates clean.
  const errors = definition.validateConfig(config, { environment: ENVIRONMENT, secrets: {} });
  if (Object.keys(errors).length) {
    throw new Error(`config rejected: ${JSON.stringify(errors)}`);
  }

  const existing = await prisma.sapConnection.findFirst({
    where: { clientId: CLIENT_ID, environment: ENVIRONMENT },
  });

  const connection = existing
    ? await prisma.sapConnection.update({
      where: { pk: existing.pk },
      data: { driver: DRIVER_KEY, config, updatedBy: 'dev-script', lastTest: null },
    })
    : await prisma.sapConnection.create({
      data: {
        clientId: CLIENT_ID, environment: ENVIRONMENT, driver: DRIVER_KEY, config,
        createdBy: 'dev-script', updatedBy: 'dev-script',
      },
    });

  invalidateSapAdapter(CLIENT_ID);

  console.log(`${existing ? 'Updated' : 'Created'} SapConnection ${connection.pk}`);
  console.log(`  clientId=${CLIENT_ID} environment=${ENVIRONMENT} driver=${DRIVER_KEY}`);
  console.log(`  client.sapEnvironment=${client.sapEnvironment} (this connection is ${client.sapEnvironment === ENVIRONMENT ? 'ALREADY the active one' : 'NOT active — promote it or reconfigure the active environment instead'})`);
  console.log('\nNext: approve a vendor with no sapVendorCode yet (or clear one) to see a real VENDOR_CR call.');
  console.log('Test it first with: node scripts/dev-test-nucleus-sap.js');
};

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
