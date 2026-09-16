// Issue #79: this instance's Z REST endpoints are documented as reachable
// with no authentication at all — the OData gateway needs a technical user
// this tenant's SapConnection has no credentials for, so the driver silently
// omits the Authorization header rather than failing (see s4odata.driver.js's
// authHeader). That is a tolerable gap for a sandbox; it must never be true
// of a connection the console lets a tenant promote to production. Shared by
// every real driver's own validateConfig — mock is exempt, since it has no
// secrets to configure and nothing it does ever reaches a real SAP system.
const requireProductionCredentials = (errors, { environment, secrets = {}, secretFields }) => {
  if (environment !== 'production') return;

  const missing = secretFields.filter((field) => !secrets[field.name]);
  if (missing.length) {
    errors.credentials = `Production requires ${missing.map((field) => field.label).join(', ')} to be configured — an unauthenticated production connection is not permitted`;
  }
};

module.exports = { requireProductionCredentials };
