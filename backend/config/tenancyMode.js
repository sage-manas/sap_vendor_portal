// How a signed-out request names the workspace it is for (ADR-0044).
//
//   subdomain  (default) the hostname decides: acme.<PORTAL_BASE_DOMAIN> is Acme's.
//              Needs wildcard DNS and a wildcard certificate. ADR-0028.
//   account    one address for everyone. The account that signs in carries its
//              own clientId, so nothing about the hostname matters; a tenant's
//              branding and self-registration come from a `?workspace=<slug>`
//              link its administrator shares.
//
// Read at call time, not at load, so a test can flip it per case.

const MODES = ['subdomain', 'account'];

const configuredMode = () => String(process.env.PORTAL_TENANCY_MODE || '').trim().toLowerCase();

// An unset variable is the historical behaviour. A value that is set but not
// one of the two is a typo, and validateEnv refuses to boot on it rather than
// quietly falling back to a different tenancy model than the operator meant.
const tenancyMode = () => (configuredMode() === 'account' ? 'account' : 'subdomain');

const isAccountTenancy = () => tenancyMode() === 'account';

const invalidTenancyMode = () => {
  const value = configuredMode();
  return value && !MODES.includes(value) ? value : null;
};

module.exports = { MODES, tenancyMode, isAccountTenancy, invalidTenancyMode };
