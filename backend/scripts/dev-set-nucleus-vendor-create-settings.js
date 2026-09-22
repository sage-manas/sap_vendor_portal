/**
 * Fills Nucleus Manufacturing's `sapVendorCreate` tenant settings — the values
 * sap/mappings/vendor-create.map.js reads when building the VENDOR_CR payload.
 *
 * These are a SEPARATE config surface from the SapConnection row
 * (scripts/dev-configure-nucleus-sap.js): the connection says *where* SAP is,
 * these say what account group / company code / GL account new vendors are
 * created under. With them unset, VENDOR_CR goes out with empty
 * account_group and company_code and SAP answers "Vendor Creation Failed".
 *
 * Values are taken from the one worked VENDOR_CR request/response pair in the
 * BAPI documentation (the request that created vendor 1120250075), so they
 * match a payload that is known to have been accepted by this system.
 *
 * Stands in for the workspace settings screen
 * (controllers/workspace.controller.js#updateSettings) — goes through the same
 * applySettings() validation, but writes with rawPrisma and no audit entry,
 * since a script has no request/actor context.
 *
 *   node scripts/dev-set-nucleus-vendor-create-settings.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { rawPrisma: prisma } = require('../db/prisma');
const { applySettings, topLevelFieldsFor, settingValue } = require('../config/tenantSettings');

const CLIENT_ID = 'CLT-0001';

// From the confirmed-working VENDOR_CR sample payload.
const PATCH = {
  'sapVendorCreate.accountGroup': 'SSDN',
  'sapVendorCreate.industry': 'ZENT',
  'sapVendorCreate.language': 'E',
  'sapVendorCreate.companyCode': 'SSDN',
  'sapVendorCreate.reconciliationAccount': '0000040000',
  'sapVendorCreate.planningGroup': 'A1',
  'sapVendorCreate.accountStatement': '1',
  // The sample request used "1000" here, even though every read endpoint
  // reports ekorg "SSDN" for this system. "1000" is the value in the payload
  // SAP is known to have accepted, so that is what goes in — revisit with
  // MM/ABAP if the purchasing view lands on the wrong org.
  'sapVendorCreate.purchasingOrganization': '1000',
  'sapVendorCreate.schemaGroupVendor': '01',
};

const main = async () => {
  const client = await prisma.client.findFirst({ where: { clientId: CLIENT_ID } });
  if (!client) throw new Error(`no client with clientId ${CLIENT_ID}`);

  const changed = applySettings(client, PATCH);
  if (!changed.length) {
    console.log('No changes — every setting already holds these values.');
    return;
  }

  const fields = topLevelFieldsFor(changed);
  const data = Object.fromEntries(fields.map((field) => [field, client[field]]));
  await prisma.client.update({ where: { pk: client.pk }, data });

  console.log(`Updated ${changed.length} setting(s) on ${CLIENT_ID}:`);
  for (const key of Object.keys(PATCH)) {
    console.log(`  ${key} = ${JSON.stringify(settingValue(client, key))}${changed.includes(key) ? '' : '  (unchanged)'}`);
  }
};

main()
  .catch((err) => { console.error(err.message, err.fields ? JSON.stringify(err.fields) : ''); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
