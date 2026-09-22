/**
 * Prints a working set-password link for a supplier whose mailbox doesn't exist.
 *
 *   node scripts/dev-set-password-link.js accounts@kaveriforge.in
 *
 * Stands in for the supplierWelcome / password-reset email: issues a fresh reset
 * token exactly as createVendor and forgotPassword do (only the hash is stored)
 * and prints the /reset-password link the email would have carried. Opening it
 * and choosing a password is the real flow from there on.
 *
 * Development only — refuses to run with NODE_ENV=production.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { rawPrisma: prisma } = require('../db/prisma');
const { issueResetToken, RESET_TOKEN_TTL_MS } = require('../db/credentials');
const { frontendUrl } = require('../config/emailTemplates');

const main = async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('dev-set-password-link is development-only');
  }
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('usage: node scripts/dev-set-password-link.js <supplier email>');

  const vendor = await prisma.vendor.findFirst({ where: { email } });
  if (!vendor) throw new Error(`no supplier with email ${email}`);

  const { rawToken, fields } = issueResetToken();
  await prisma.vendor.update({ where: { pk: vendor.pk }, data: fields });

  console.log(`Supplier: ${vendor.companyName} (${vendor.vendorId}, tenant ${vendor.clientId})`);
  console.log(`Set-password link (valid ${RESET_TOKEN_TTL_MS / 60000} min):`);
  console.log(`${frontendUrl()}/reset-password?token=${rawToken}`);
};

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
