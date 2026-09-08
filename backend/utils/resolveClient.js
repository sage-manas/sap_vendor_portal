const { prisma } = require('../db/prisma');

const LEGACY_CLIENT_ID = 'CLT-0001';
const LEGACY_CLIENT_SLUG = 'legacy';

// Hostnames that are never a tenant: the marketing site, the operator console,
// and the bare apex.
const RESERVED_LABELS = new Set(['www', 'platform', 'app', 'api', 'admin']);

// Which tenant is an unauthenticated request (registration, the sign-in realm)
// talking to?
//
// The subdomain is the authority. `x-client-slug` is a development affordance
// so a localhost deployment can act as any tenant without a wildcard DNS
// entry — in production it is ignored outright, because a header a browser can
// set must never be able to choose a workspace.
const isProduction = () => process.env.NODE_ENV === 'production';

const hostOf = (req) =>
  String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().split(':')[0];

/**
 * The slug this request is addressed to, and where that answer came from.
 * `source` matters: only a slug that a real subdomain named is strong enough to
 * refuse a login (see auth.controller), because the fallback is a guess.
 */
const realmFromRequest = (req) => {
  const host = hostOf(req);
  const isIpAddress = /^\d+(\.\d+){3}$/.test(host);
  const labels = host.split('.');

  // Only a real multi-label hostname carries a subdomain — never a bare IP,
  // whose dotted quads look like labels but are not.
  if (!isIpAddress && labels.length >= 3 && !RESERVED_LABELS.has(labels[0].toLowerCase())) {
    return { slug: labels[0].toLowerCase(), source: 'subdomain' };
  }

  const header = req.headers['x-client-slug'];
  if (header && !isProduction()) {
    return { slug: String(header).toLowerCase(), source: 'header' };
  }

  return {
    slug: (process.env.DEFAULT_CLIENT_SLUG || LEGACY_CLIENT_SLUG).toLowerCase(),
    source: 'default',
  };
};

const slugFromRequest = (req) => realmFromRequest(req).slug;

// Client is not tenant-scoped (excluded from tenantExtension's model list, see
// backend/db/tenantExtension.js), so this needs no withoutTenantScope wrapper
// — unlike the Mongoose plugin, the Prisma extension never touches this model
// regardless of what tenant context is bound.
const findClientBySlug = (slug) => prisma.client.findFirst({ where: { slug } });

const resolveClientForRequest = async (req) => findClientBySlug(slugFromRequest(req));

/**
 * The realm plus the tenant it resolved to, for the paths that need to know how
 * the answer was reached. Returns `client: null` when no such workspace exists.
 */
const resolveRealmForRequest = async (req) => {
  const realm = realmFromRequest(req);
  return { ...realm, client: await findClientBySlug(realm.slug) };
};

module.exports = {
  resolveClientForRequest,
  resolveRealmForRequest,
  realmFromRequest,
  slugFromRequest,
  LEGACY_CLIENT_ID,
  LEGACY_CLIENT_SLUG,
};
