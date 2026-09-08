const { PrismaClient } = require('@prisma/client');
const { createTenantExtension } = require('./tenantExtension');
const { appendOnlyExtension } = require('./appendOnlyExtension');

// Single Prisma instance for the whole process, extended with tenant scoping
// and append-only enforcement. Controllers import `{ prisma }` and call
// `prisma.rFQ.findMany(...)` etc. exactly as they call `RFQ.find(...)` today —
// the AsyncLocalStorage binding set up per-request by middleware/auth.js's
// `protect` (via runWithTenant) is what makes the injected clientId differ
// per request even though this client is one shared instance.
//
// `omit` replicates Mongoose's `select: false` on credential fields
// (models/plugins/credentialsPlugin.js, models/SapConnection.js): Prisma has
// no schema-level "hidden unless asked for" concept, so every field comes
// back on every query by default — without this, any accidental
// `res.json(vendor)` would leak a bcrypt hash. A call site that genuinely
// needs one of these (login, changePassword, the SAP driver factory) opts
// back in per-query with `omit: { vendor: { password: false } }` etc.
const rawPrisma = new PrismaClient({
  omit: {
    vendor: {
      password: true,
      resetPasswordToken: true,
      resetPasswordExpires: true,
    },
    user: {
      password: true,
      resetPasswordToken: true,
      resetPasswordExpires: true,
    },
    platformUser: {
      password: true,
      resetPasswordToken: true,
      resetPasswordExpires: true,
      mfaSecret: true,
    },
    sapConnection: {
      wrappedDataKey: true,
    },
  },
});
const prisma = rawPrisma.$extends(createTenantExtension(rawPrisma)).$extends(appendOnlyExtension);

module.exports = { prisma, rawPrisma };
