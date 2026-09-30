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

// The host is Express's own answer (`req.hostname`), which believes
// X-Forwarded-Host only from a proxy `trust proxy` names (config/trustProxy.js:
// the local nginx, which overwrites it). Reading that header directly, as this
// used to, let any client name its own workspace. A bare request object (a unit
// test) falls back to the Host header, never to X-Forwarded-Host.
const hostOf = (req) =>
  String(req.hostname ?? req.headers?.host ?? '').split(',')[0].trim().split(':')[0].toLowerCase();

// The domain workspaces hang off: `acme.<PORTAL_BASE_DOMAIN>` is Acme's. Required
// in production (config/validateEnv.js), because without it the only thing to go
// on is "the first label of a three-part host", which reads `vendorportal` out of
// `vendorportal.example.com` as a tenant and rejects every login there.
const baseDomain = () => String(process.env.PORTAL_BASE_DOMAIN || '').trim().toLowerCase().replace(/^\./, '');

/**
 * The slug this request is addressed to, and where that answer came from.
 * `source` matters: only a slug that a real subdomain named is strong enough to
 * refuse a login (see auth.controller), because the fallback is a guess.
 */
const realmFromRequest = (req) => {
  const host = hostOf(req);
  const base = baseDomain();

  if (base) {
    // `slug: null` means "this host names no workspace" — the apex, the console
    // and marketing names, or a host that is not ours at all. Never a guess.
    if (host === base) return { slug: null, source: 'apex' };
    if (host.endsWith(`.${base}`)) {
      const prefix = host.slice(0, -(base.length + 1));
      if (prefix.includes('.')) return { slug: null, source: 'unknown_host' };
      if (RESERVED_LABELS.has(prefix)) return { slug: null, source: 'reserved' };
      return { slug: prefix, source: 'subdomain' };
    }
    // Outside the base domain. Development (localhost) keeps its header and
    // default fallbacks below; production answers to no other name.
    if (isProduction()) return { slug: null, source: 'unknown_host' };
  }

  const isIpAddress = /^\d+(\.\d+){3}$/.test(host);
  const labels = host.split('.');

  // Only a real multi-label hostname carries a subdomain — never a bare IP,
  // whose dotted quads look like labels but are not.
  if (!base && !isIpAddress && labels.length >= 3 && !RESERVED_LABELS.has(labels[0].toLowerCase())) {
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
const findClientBySlug = async (slug) => (slug ? prisma.client.findFirst({ where: { slug } }) : null);

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
