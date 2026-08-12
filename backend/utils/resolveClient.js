const Client = require('../models/Client');
const { withoutTenantScope } = require('./tenantContext');

const LEGACY_CLIENT_ID = 'CLT-0001';
const LEGACY_CLIENT_SLUG = 'legacy';

// Which tenant is an unauthenticated request (registration, login realm)
// talking to? Phase 6 makes this properly subdomain-driven; until then the
// header is a dev affordance and DEFAULT_CLIENT_SLUG/legacy is the fallback so
// the existing single-tenant deployment keeps working unchanged.
const slugFromRequest = (req) => {
  const explicit = req.headers['x-client-slug'];
  if (explicit) return String(explicit).toLowerCase();

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const isIpAddress = /^\d+(\.\d+){3}$/.test(host);
  const parts = host.split('.');
  // Only treat it as a tenant subdomain on a real multi-label hostname —
  // never on a bare IP, whose dotted quads are not subdomains.
  if (!isIpAddress && parts.length >= 3 && parts[0] !== 'www' && parts[0] !== 'platform') {
    return parts[0].toLowerCase();
  }
  return (process.env.DEFAULT_CLIENT_SLUG || LEGACY_CLIENT_SLUG).toLowerCase();
};

// Client is not tenant-scoped, but it is read here before any context exists,
// so the lookup is explicitly unscoped.
const resolveClientForRequest = async (req) => {
  const slug = slugFromRequest(req);
  return withoutTenantScope(() => Client.findOne({ slug }));
};

module.exports = { resolveClientForRequest, slugFromRequest, LEGACY_CLIENT_ID, LEGACY_CLIENT_SLUG };
