const { prisma } = require('../db/prisma');
const { isClientOperational } = require('../db/clientHelpers');
const { canAuthenticate } = require('../db/accountHelpers');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { planeOf, PLANES } = require('../config/roles');
const { hasPermission, permissionsFor } = require('../config/permissions');
const { ACCOUNT_TYPES, verifyToken, normalizeClaims } = require('../utils/authToken');

// Identity is resolved before any tenant is known, so these lookups are
// explicitly unscoped. They are the only unscoped reads in the request path.
//
// `sub` is the account's Prisma `pk` (a uuid) since every token is minted
// fresh post-cutover (see utils/authToken.js). The vendorId fallback exists
// for the same reason it existed against Mongoose: a `sub` that doesn't
// resolve at all (stale/foreign token) should still get one more chance via
// the business id carried alongside it, rather than an immediate 401.
const ACCOUNT_LOADERS = {
  [ACCOUNT_TYPES.VENDOR]: (claims) =>
    withoutTenantScope(async () => {
      const byPk = claims.sub
        ? await prisma.vendor.findFirst({ where: { pk: claims.sub } })
        : null;
      if (byPk) return byPk;
      return claims.vendorId
        ? prisma.vendor.findFirst({ where: { vendorId: claims.vendorId } })
        : null;
    }),
  [ACCOUNT_TYPES.USER]: (claims) =>
    withoutTenantScope(() => prisma.user.findFirst({ where: { pk: claims.sub } })),
  [ACCOUNT_TYPES.PLATFORM]: (claims) =>
    prisma.platformUser.findFirst({ where: { pk: claims.sub } }), // not tenant-scoped, no opt-out needed
};

const findClient = (clientId) => prisma.client.findFirst({ where: { clientId } });

const bearerToken = (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
};

// Resolves the token's subject and checks the account is still allowed to act:
// the role it holds today decides the plane, not the claim it was signed with.
const resolveAccount = async (req) => {
  const token = bearerToken(req);
  if (!token) {
    throw ApiError.unauthorized('Not authorized to access this route, token missing');
  }

  let claims;
  try {
    claims = normalizeClaims(verifyToken(token));
  } catch (error) {
    throw ApiError.unauthorized('Not authorized, invalid token');
  }

  const load = ACCOUNT_LOADERS[claims.accountType];
  if (!load) {
    throw ApiError.unauthorized('Not authorized, unknown account type');
  }

  const account = await load(claims);
  if (!account) {
    throw ApiError.unauthorized('Not authorized, account not found');
  }

  // A role change since the token was minted invalidates it: the alternative is
  // a demoted account keeping its old permissions for up to 30 days.
  if (claims.role && claims.role !== account.role) {
    throw ApiError.unauthorized('Not authorized, session is stale — sign in again');
  }

  if (!canAuthenticate(account, claims.accountType)) {
    throw ApiError.forbidden('This account is not active');
  }

  return { account, claims, plane: planeOf(account.role) };
};

// Attaches the principal every downstream guard and controller reads.
const attachPrincipal = (req, account, plane) => {
  req.auth = {
    accountType: plane === PLANES.SUPPLIER ? ACCOUNT_TYPES.VENDOR
      : plane === PLANES.TENANT ? ACCOUNT_TYPES.USER
        : ACCOUNT_TYPES.PLATFORM,
    id: account.pk,
    role: account.role,
    plane,
    email: account.email,
    clientId: account.clientId || null,
    permissions: permissionsFor(account.role),
    // Reported on every session, not just the login response, so the gate
    // survives a reload: an account still on the temporary password it was
    // provisioned with must not be able to skip the change by refreshing.
    mustChangePassword: Boolean(account.mustChangePassword),
  };
  req.roleScope = plane;
};

/**
 * Tenant-plane and supplier-plane authentication. Binds the account's tenant
 * for the remainder of the request, which is what makes the tenant
 * extension's "throw when unbound" safe rather than noisy.
 *
 * Platform accounts are refused here with a 403 before any query runs — they
 * have their own surface under /api/platform (see `protectPlatform`).
 */
const protect = asyncHandler(async (req, res, next) => {
  const { account, claims, plane } = await resolveAccount(req);

  if (plane === PLANES.PLATFORM) {
    return next(ApiError.forbidden('Platform accounts cannot access tenant endpoints'));
  }

  if (!account.clientId) {
    return next(ApiError.unauthorized('Account is not attached to a tenant'));
  }

  // A token minted for one tenant can never act on another, even if the
  // account document was moved.
  if (claims.clientId && claims.clientId !== account.clientId) {
    return next(ApiError.unauthorized('Not authorized, token tenant mismatch'));
  }

  const client = await findClient(account.clientId);
  if (!client || !isClientOperational(client)) {
    return next(ApiError.forbidden('This workspace is not active'));
  }

  attachPrincipal(req, account, plane);
  req.client = client;
  req.clientId = account.clientId;

  if (plane === PLANES.SUPPLIER) {
    req.vendor = account;
    req.vendorId = account.vendorId;
    req.clerkUserId = account.vendorId; // backward compatibility
    // Suppliers only ever see their own rows. Tenant staff leave this unset and
    // see the whole tenant — the one place that distinction is expressed.
    req.scopeVendorId = account.vendorId;
  } else {
    req.user = account;
    req.scopeVendorId = null;
  }

  return runWithTenant(account.clientId, () => next());
});

/**
 * Platform-plane authentication for /api/platform/*. Never binds a tenant:
 * platform code that needs to touch a tenant collection must say so with an
 * explicit withoutTenantScope() or runWithTenant().
 */
const protectPlatform = asyncHandler(async (req, res, next) => {
  const { account, claims, plane } = await resolveAccount(req);

  if (plane !== PLANES.PLATFORM) {
    // Do not confirm that the platform console exists to tenant accounts.
    return next(ApiError.notFound('Not found'));
  }

  attachPrincipal(req, account, plane);
  req.platformUser = account;
  // The second factor's state, for `requireMfa` below. Enrolment is a property
  // of the account; verification is a property of this particular token.
  req.mfa = { enrolled: Boolean(account.mfaEnabled), verified: claims.mfa === true };
  return next();
});

/**
 * The platform plane's second gate: MFA is mandatory on the console (ADR-0016).
 * Mounted on everything except the handful of endpoints an operator needs in
 * order to enrol — /auth/me, /auth/change-password and /auth/mfa/*.
 *
 * The two refusals are distinguishable on purpose: the client has to know
 * whether to show an enrolment screen or a code prompt.
 */
const requireMfa = (req, res, next) => {
  if (!req.mfa) {
    return next(ApiError.unauthorized('Not authorized to access this route'));
  }
  if (!req.mfa.enrolled) {
    return next(ApiError.forbidden('Multi-factor authentication must be enrolled before using the platform console', { reason: 'mfa_enrolment_required' }));
  }
  if (!req.mfa.verified) {
    return next(ApiError.forbidden('This session has not cleared multi-factor authentication', { reason: 'mfa_verification_required' }));
  }
  return next();
};

/**
 * Route-level authorization. Every protected route declares exactly one
 * permission; who holds it is decided in config/permissions.js and nowhere
 * else. The declaration is readable off the middleware (`fn.permission`), which
 * is how the route×role matrix test finds routes that declare nothing.
 */
const requirePermission = (permission) => {
  if (!permission) throw new Error('requirePermission needs a permission');

  const guard = (req, res, next) => {
    if (!req.auth) {
      return next(ApiError.unauthorized('Not authorized to access this route'));
    }
    if (!hasPermission(req.auth.role, permission)) {
      return next(ApiError.forbidden('Not authorized for this action'));
    }
    return next();
  };

  guard.permission = permission;
  return guard;
};

// Plane assertion for routes whose permission is held on more than one plane.
const requirePlane = (...planes) => {
  const guard = (req, res, next) => {
    if (!req.auth || !planes.includes(req.auth.plane)) {
      return next(ApiError.forbidden('Not authorized for this action'));
    }
    return next();
  };
  guard.planes = planes;
  return guard;
};

module.exports = { protect, protectPlatform, requireMfa, requirePermission, requirePlane };
