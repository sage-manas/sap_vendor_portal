const { AsyncLocalStorage } = require('async_hooks');

// The single source of truth for "which tenant is this code running for".
// Bound once per request by middleware/tenantContext.js, and manually by any
// out-of-request work (simulator timers, scripts, jobs) via runWithTenant.
const storage = new AsyncLocalStorage();

const UNSCOPED = Symbol('withoutTenantScope');

// Runs fn with clientId bound. Everything awaited inside — including Mongoose
// queries several layers down — sees this tenant.
// Note the `await` inside the run callback: a Mongoose Query is lazy, so
// returning one un-awaited would execute it *after* the store had unwound and
// the tenant filter would be lost. Awaiting here keeps execution inside scope.
const runWithTenant = (clientId, fn) => {
  if (!clientId) {
    throw new Error('runWithTenant requires a clientId');
  }
  return storage.run({ clientId }, async () => await fn());
};

// Deliberate, greppable escape hatch for platform-plane work and for the few
// pre-authentication queries (login, register, password reset) that must find a
// document before any tenant is known. Never call this from a tenant endpoint.
const withoutTenantScope = (fn) => storage.run({ clientId: null, [UNSCOPED]: true }, async () => await fn());

const getTenantId = () => storage.getStore()?.clientId ?? null;

const isUnscoped = () => storage.getStore()?.[UNSCOPED] === true;

// True when either a tenant is bound or the caller explicitly opted out.
// Anything else is a bug, and the tenant plugin turns it into a thrown error.
const hasTenantBinding = () => getTenantId() !== null || isUnscoped();

class MissingTenantContextError extends Error {
  constructor(modelName, op) {
    super(
      `Tenant context missing: refusing to run ${modelName}.${op}() without a bound clientId. ` +
      `Wrap the call in runWithTenant(clientId, fn), or — for platform-plane work only — withoutTenantScope(fn).`
    );
    this.name = 'MissingTenantContextError';
    this.statusCode = 500;
  }
}

module.exports = {
  runWithTenant,
  withoutTenantScope,
  getTenantId,
  isUnscoped,
  hasTenantBinding,
  MissingTenantContextError,
};
