const crypto = require('crypto');
const { prisma } = require('../db/prisma');
const { hashPassword } = require('../db/credentials');
const ApiError = require('../utils/ApiError');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { sendMail } = require('../utils/mailer');
const { frontendUrl } = require('../config/emailTemplates');
const { ROLES } = require('../config/roles');

// Creating a tenant is two writes that must agree: the Client, and the first
// client_admin inside it. Both live here so the console, the seed scripts and
// anything later (a signup funnel, a sales tool) provision identically.

const CLIENT_ID_PREFIX = 'CLT-';
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// Reserved because they are, or will be, real hosts on the same domain.
const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'platform', 'status', 'docs', 'mail', 'static',
  'assets', 'cdn', 'support', 'help', 'billing', 'login', 'signup', 'legacy',
]);

// 18 bytes of base64url. Generated, emailed once, and never stored in
// plaintext — the account carries a bcrypt hash and mustChangePassword.
const generatePassword = () => crypto.randomBytes(18).toString('base64url');

/**
 * The next free CLT-#### . Sequential rather than random because operators
 * read these aloud; the uniqueness guarantee is the unique index, and a
 * collision under concurrency surfaces as a duplicate-key error the caller
 * retries.
 */
const nextClientId = async () => {
  const [latest] = await withoutTenantScope(() =>
    prisma.client.findMany({
      where: { clientId: { startsWith: CLIENT_ID_PREFIX } },
      orderBy: { clientId: 'desc' },
      take: 1,
      select: { clientId: true },
    })
  );

  const highest = latest ? Number(latest.clientId.slice(CLIENT_ID_PREFIX.length)) : 0;
  return `${CLIENT_ID_PREFIX}${String((Number.isFinite(highest) ? highest : 0) + 1).padStart(4, '0')}`;
};

const assertSlugAvailable = async (slug) => {
  const normalized = String(slug || '').toLowerCase().trim();

  if (!SLUG_PATTERN.test(normalized)) {
    throw ApiError.badRequest('Workspace address must be 3-40 characters: lowercase letters, digits and hyphens, not starting or ending with a hyphen');
  }
  if (RESERVED_SLUGS.has(normalized)) {
    throw ApiError.badRequest(`"${normalized}" is reserved and cannot be used as a workspace address`);
  }
  if (await withoutTenantScope(() => prisma.client.findFirst({ where: { slug: normalized } }))) {
    throw ApiError.conflict('That workspace address is already taken');
  }

  return normalized;
};

// One email holds one account across the whole platform: login resolves the
// account before any tenant is known (ADR-0002), so both identity collections
// are checked.
const assertEmailAvailable = async (email) => {
  const normalized = String(email || '').toLowerCase().trim();
  const taken = await withoutTenantScope(async () =>
    (await prisma.user.findFirst({ where: { email: normalized } })) ||
    (await prisma.vendor.findFirst({ where: { email: normalized } })));

  if (taken) {
    throw ApiError.conflict('An account already exists for this email');
  }
  return normalized;
};

/**
 * Issues credentials for a tenant's administrator and emails them.
 * Returns the User; the password is deliberately not returned to the caller,
 * so it cannot end up in an API response, a log line or an audit entry.
 */
const issueClientAdmin = async ({ client, email, name, invitedBy }) => {
  const plainPassword = generatePassword();
  const { password, passwordChangedAt } = await hashPassword(plainPassword);

  const admin = await runWithTenant(client.clientId, () => prisma.user.create({
    data: {
      email,
      name: name || email,
      role: ROLES.CLIENT_ADMIN,
      status: 'Active',
      password,
      passwordChangedAt,
      mustChangePassword: true,
      invitedBy,
      invitedAt: new Date(),
      activatedAt: new Date(),
    },
  }));

  await sendMail({
    to: admin.email,
    template: 'tenantAdminCredentials',
    data: {
      name: admin.name,
      companyName: client.companyName,
      email: admin.email,
      temporaryPassword: plainPassword,
      loginUrl: `${frontendUrl()}/sign-in?workspace=${encodeURIComponent(client.slug)}`,
    },
  });

  return admin;
};

/**
 * Creates a tenant and its first administrator as one operation.
 *
 * If the administrator cannot be created the Client is removed again: a tenant
 * with no way in is worse than no tenant, and there is no transaction to lean
 * on across the two calls (issueClientAdmin sends an email in between).
 */
const provisionTenant = async ({ companyName, slug, plan, limits, branding, featureFlags, admin, createdBy }) => {
  const normalizedSlug = await assertSlugAvailable(slug);
  const adminEmail = await assertEmailAvailable(admin?.email);

  const clientId = await nextClientId();

  const client = await withoutTenantScope(() => prisma.client.create({
    data: {
      clientId,
      companyName,
      slug: normalizedSlug,
      status: 'Trial',
      plan: plan || 'trial',
      ...(limits && {
        ...(limits.vendors != null && { limitVendors: limits.vendors }),
        ...(limits.rfqsPerMonth != null && { limitRfqsPerMonth: limits.rfqsPerMonth }),
        ...(limits.storageMb != null && { limitStorageMb: limits.storageMb }),
      }),
      ...(branding && {
        ...(branding.logo != null && { brandingLogo: branding.logo }),
        ...(branding.primaryColor != null && { brandingColor: branding.primaryColor }),
      }),
      ...(featureFlags && { featureFlags }),
      createdBy,
    },
  }));

  try {
    const clientAdmin = await issueClientAdmin({
      client,
      email: adminEmail,
      name: admin?.name,
      invitedBy: createdBy,
    });
    return { client, clientAdmin };
  } catch (error) {
    await withoutTenantScope(() => prisma.client.delete({ where: { pk: client.pk } }));
    throw error;
  }
};

/**
 * Re-issues the tenant administrator's credentials — the "they never got the
 * email" path. Only ever resets a password; it never creates a second admin.
 */
const reissueAdminCredentials = async ({ client, userId }) => {
  const admin = await runWithTenant(client.clientId, () => prisma.user.findFirst({ where: { pk: userId } }));
  if (!admin) {
    throw ApiError.notFound('Not found');
  }

  const plainPassword = generatePassword();
  const { password, passwordChangedAt } = await hashPassword(plainPassword);
  await runWithTenant(client.clientId, () => prisma.user.update({
    where: { pk: admin.pk },
    data: { password, passwordChangedAt, mustChangePassword: true },
  }));

  await sendMail({
    to: admin.email,
    template: 'tenantAdminCredentials',
    data: {
      name: admin.name,
      companyName: client.companyName,
      email: admin.email,
      temporaryPassword: plainPassword,
      loginUrl: `${frontendUrl()}/sign-in?workspace=${encodeURIComponent(client.slug)}`,
    },
  });

  return admin;
};

module.exports = {
  provisionTenant,
  issueClientAdmin,
  reissueAdminCredentials,
  nextClientId,
  assertSlugAvailable,
  assertEmailAvailable,
  generatePassword,
  RESERVED_SLUGS,
};
