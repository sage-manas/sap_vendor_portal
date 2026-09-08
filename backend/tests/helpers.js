const request = require('supertest');
const { prisma, rawPrisma } = require('../db/prisma');
const { hashPassword } = require('../db/credentials');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { signToken } = require('../utils/authToken');
const { encrypt } = require('../utils/secretBox');
const totp = require('../utils/totp');
const { ROLES } = require('../config/roles');

const baseVendor = {
  vendorId: 'vendor_test_001',
  password: 'secret123',
  companyName: 'Acme Industries Pvt Ltd',
  gstin: '27AABCB1234F1Z5',
  pan: 'AABCB1234F',
  email: 'acme@example.com',
  phone: '9876543210',
  address: '12 MG Road',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  bankName: 'HDFC Bank',
  accountNumber: '123456789012',
  ifscCode: 'HDFC0000060',
  accountName: 'Acme Industries Pvt Ltd',
  bankBranch: 'Pune Main'
};

// Every test needs at least one tenant to exist: registration resolves the
// workspace by slug before it will create anything.
const seedClient = async ({ clientId = 'CLT-0001', slug = 'legacy', companyName = 'Legacy' } = {}) =>
  withoutTenantScope(async () => {
    const existing = await rawPrisma.client.findFirst({ where: { clientId } });
    if (existing) return existing;
    return rawPrisma.client.create({ data: { clientId, slug, companyName, status: 'Active' } });
  });

// Registration leaves a supplier in Draft, and the transacting modules stay shut
// until they submit (middleware/requireOnboarded.js). A suite testing what
// happens *after* onboarding says so with `onboarded: true` rather than walking
// the registration form again; a suite testing the gate itself leaves it off.
const onboardVendor = (vendorId, { clientId = 'CLT-0001', status = 'Approved' } = {}) =>
  runWithTenant(clientId, () => prisma.vendor.updateMany({ where: { vendorId }, data: { status } }));

// Registers a vendor through the real API and returns { token, vendor }.
// `clientSlug` picks the workspace (see utils/resolveClient.js).
const registerVendor = async (app, overrides = {}, { clientSlug = 'legacy', onboarded = false } = {}) => {
  const clientId = overrides.clientId || 'CLT-0001';
  await seedClient({ slug: clientSlug, clientId });
  const payload = { ...baseVendor, ...overrides };
  delete payload.clientId;
  const res = await request(app)
    .post('/api/auth/register')
    .set('x-client-slug', clientSlug)
    .send(payload);
  if (res.status !== 201) {
    throw new Error(`Test vendor registration failed: ${JSON.stringify(res.body)}`);
  }
  if (onboarded) {
    await onboardVendor(res.body.vendor.vendorId, { clientId });
  }
  return { token: res.body.token, vendor: res.body.vendor, payload };
};

const signTokenFor = (account) => signToken(account);

// Tenant staff live in the User table (ADR-0007) and are created by
// invitation or provisioning, never by the public register endpoint — so tests
// create them directly, the same way the invite-accept flow does. Password
// hashing was an implicit Mongoose pre-save hook; it is explicit here.
const createTenantUser = async ({ role = ROLES.CLIENT_ADMIN, clientId = 'CLT-0001', password = 'secret123', ...rest } = {}) => {
  await seedClient({ clientId, slug: clientId === 'CLT-0001' ? 'legacy' : clientId.toLowerCase() });
  const { password: hashed, passwordChangedAt } = await hashPassword(password);
  const user = await runWithTenant(clientId, () => prisma.user.create({
    data: {
      email: `${role}@example.com`,
      name: `Test ${role}`,
      role,
      status: 'Active',
      password: hashed,
      passwordChangedAt,
      ...rest,
    },
  }));
  return { token: signTokenFor(user), user };
};

const createAdminUser = (overrides = {}) => createTenantUser({ role: ROLES.CLIENT_ADMIN, ...overrides });

const createPlatformUser = async ({ role = ROLES.SUPER_ADMIN, password = 'secret123', ...rest } = {}) => {
  const { password: hashed, passwordChangedAt } = await hashPassword(password);
  const operator = await rawPrisma.platformUser.create({
    data: {
      email: `${role}@platform.example.com`,
      name: `Test ${role}`,
      role,
      status: 'Active',
      password: hashed,
      passwordChangedAt,
      ...rest,
    },
  });
  return { token: signTokenFor(operator), operator };
};

// An operator who has already enrolled and cleared MFA — the only kind of
// session the console proper accepts (ADR-0016). `secret` is returned so a test
// can generate a valid code for itself.
const createOperatorSession = async ({ role = ROLES.SUPER_ADMIN, ...rest } = {}) => {
  const secret = totp.generateSecret();
  const { operator } = await createPlatformUser({
    role,
    mfaEnabled: true,
    mfaSecret: encrypt(secret),
    mfaEnrolledAt: new Date(),
    ...rest,
  });

  return { token: signToken(operator, { mfa: true }), operator, secret };
};

// Test code that touches models directly is subject to the same rule as
// application code: bind a tenant, or the query throws.
const asTenant = (fn, clientId = 'CLT-0001') => runWithTenant(clientId, fn);

module.exports = {
  baseVendor,
  registerVendor,
  onboardVendor,
  createTenantUser,
  createAdminUser,
  createPlatformUser,
  createOperatorSession,
  seedClient,
  signTokenFor,
  asTenant,
};
