const { prisma } = require('../db/prisma');
const { decryptSecrets } = require('../db/sapConnectionHelpers');
const logger = require('../utils/logger');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { recordSapCall, resolveSapCall } = require('../utils/sapLogger');
const { SAP_METHODS, METHOD_NAMES, SapDriverError } = require('./contract');
const { transaction: transactionFor } = require('../config/sapTransactions');
const { driverDefinition, DEFAULT_DRIVER } = require('./drivers');
const { createCircuitBreaker } = require('./circuitBreaker');
const { applyFieldEncoding } = require('./mappings/fields');

// `getSapAdapterForClient(clientId)` — the only way anything in this codebase
// talks to SAP.
//
// No controller imports a driver. It asks for its tenant's adapter and calls
// contract methods on it; which driver that is, whether it is pointed at
// sandbox or production, and what credentials it uses are all decisions made in
// the platform console and resolved here.
//
// The wrapper around each driver method does four things the drivers must not
// each reinvent:
//
//   1. runs the call through that tenant's circuit breaker
//   2. writes the SapLog entry, with the transaction's own code and direction
//   3. stamps `{ source, syncedAt }` on every result, so the UI can say where a
//      number came from and how old it is instead of implying it is live
//   4. re-binds the tenant context around a deferred answer, since a driver's
//      timer or webhook fires long after the request that started it

const ADAPTER_TTL_MS = 5 * 60 * 1000;

// clientId → { adapter, key, builtAt }. `key` is the connection's identity and
// revision, so a configuration change invalidates the cache on the next call
// without anything having to remember to clear it.
const cache = new Map();

const stamp = (data, driverName, method) => {
  const key = SAP_METHODS[method]?.transaction;
  const { code, type } = key ? transactionFor(key) : {};

  return {
    ...(data || {}),
    // 'mock' is a truthful answer, not a placeholder: a tenant on the simulator
    // must never see a screen implying its numbers came from a real system.
    source: driverName,
    syncedAt: new Date().toISOString(),
    // What was called, so a caller that wants to announce the call over a
    // socket does not have to retype the transaction name the registry already
    // holds.
    ...(key && { transaction: { code, type } }),
  };
};

const wrapImmediate = (driverName, method, fn, breaker) => async (args = {}) => {
  const spec = SAP_METHODS[method];
  // Encoded — and, on a SapFieldError, thrown — before the breaker ever sees
  // this call: a value that fails LIFNR/MATNR/EBELN/... encoding is our own
  // bug or bad data, not SAP being down, and must never count against the
  // breaker or be written up as a failed SAP call (see catch block below,
  // which never runs for this).
  const encodedArgs = applyFieldEncoding(spec.fields, args);

  let result;
  try {
    result = await breaker.run(() => fn(encodedArgs));
  } catch (error) {
    // A failed call still belongs in the tenant's SAP log — a log that only
    // records successes is the one you cannot debug with.
    if (spec.logged !== false && spec.transaction) {
      await recordSapCall({
        transaction: spec.transaction,
        vendorId: args.vendorId || args.vendor?.vendorId || 'SYSTEM',
        payload: { error: error.message },
        status: 'FAILED',
        errorMessage: error.message,
        documentRef: args.documentRef || '',
      });
    }
    if (error.code === 'sap_circuit_open' || error.code === 'not_implemented') throw error;
    throw new SapDriverError(error.message, { driver: driverName, method, cause: error });
  }

  const { data, log } = result || {};
  if (log && spec.transaction) {
    const entry = await recordSapCall({ transaction: spec.transaction, ...log });
    // The caller needs the entry's id only when the call is still open — the
    // vendor-create BAPI awaiting its confirmation.
    if (entry && log.status === 'PENDING') return { ...stamp(data, driverName, method), pendingLogId: entry.pk };
  }

  return stamp(data, driverName, method);
};

const wrapDeferred = (driverName, method, fn, breaker, clientId) => (args = {}, handler) => {
  const spec = SAP_METHODS[method];
  // Same encode-before-the-driver-sees-it rule as wrapImmediate. Thrown here,
  // a SapFieldError propagates straight to the caller (the job handler),
  // never reaching fn() — so, same as above, it can't trip the breaker or be
  // logged as a failed SAP call.
  const encodedArgs = applyFieldEncoding(spec.fields, args);

  return fn(encodedArgs, async (answer) => {
    // The timer fired outside any request, so the tenant has to be re-bound
    // before a single query runs. This is the one place that happens now;
    // before Phase 4 it was three `runWithTenant` calls in three controllers.
    try {
      return await runWithTenant(clientId, async () => {
        const data = stamp(answer.data, driverName, method);

        // A handler returns what it persisted, or null to decline the answer —
        // the shipment was cancelled, the invoice was already cleared, the
        // supplier moved on. A declined answer produces no log entries and
        // leaves any pending call open, because as far as our records go it
        // never happened.
        const persisted = await handler(data);
        if (!persisted) return null;

        if (answer.resolve) await resolveSapCall(answer.resolve.id, answer.resolve.status);

        const entries = typeof answer.logs === 'function' ? answer.logs(data, persisted) : (answer.logs || []);
        for (const entry of entries) {
          await recordSapCall(entry);
          // An immediate call hands its transaction back in the return value
          // and the controller announces it; a deferred one has no return
          // value to hand back, so the caller passes a listener instead. Either
          // way the transaction's name comes from the registry, never a
          // literal at the call site.
          if (typeof args.onCall === 'function') {
            const { code, type } = transactionFor(entry.transaction);
            args.onCall({ code, type });
          }
        }

        return persisted;
      });
    } catch (error) {
      // A deferred answer has no request to fail; all it can do is say so.
      logger.error(`[sap] ${driverName}.${method} deferred answer failed for ${clientId}: ${error.message}`);
      if (spec.transaction) {
        await runWithTenant(clientId, () => recordSapCall({
          transaction: spec.transaction,
          vendorId: args.vendorId || args.vendor?.vendorId || 'SYSTEM',
          payload: { error: error.message },
          status: 'FAILED',
          errorMessage: error.message,
        })).catch(() => {});
      }
      return null;
    }
  });
};

const buildAdapter = ({ clientId, connection, secrets }) => {
  const driverKey = connection?.driver || DEFAULT_DRIVER;
  const definition = driverDefinition(driverKey);

  const driver = definition.create({
    clientId,
    config: connection?.config || {},
    // Decryption happens in the caller (getSapAdapterForClient /
    // buildTransientAdapter) and nowhere else. The plaintext is passed in
    // already-resolved and lives in this closure for the adapter's lifetime;
    // it is never returned, logged or attached to the adapter's public surface.
    secrets: secrets || {},
  });

  const breaker = createCircuitBreaker({
    label: `${clientId}/${driverKey}`,
    ...(connection?.config?.breaker || {}),
  });

  const adapter = {
    clientId,
    driver: driverKey,
    environment: connection?.environment || 'sandbox',
    implemented: definition.implemented,
    circuit: () => breaker.snapshot(),
  };

  for (const method of METHOD_NAMES) {
    adapter[method] = SAP_METHODS[method].deferred
      ? wrapDeferred(driverKey, method, driver[method], breaker, clientId)
      : wrapImmediate(driverKey, method, driver[method], breaker);
  }

  return adapter;
};

// Loads the connection the tenant actually runs against. `Client.sapEnvironment`
// is the promotion switch: a tenant stays on its sandbox connection until an
// operator promotes it, and nothing else flips that.
const loadConnection = async (clientId) => {
  return withoutTenantScope(async () => {
    const client = await prisma.client.findFirst({ where: { clientId }, select: { sapEnvironment: true } });
    const environment = client?.sapEnvironment || 'sandbox';
    return prisma.sapConnection.findFirst({
      where: { clientId, environment },
      omit: { wrappedDataKey: false },
    });
  });
};

const cacheKey = (connection) =>
  (connection ? `${connection.pk}:${connection.updatedAt?.getTime()}` : 'default:mock');

/**
 * The tenant's SAP adapter. Cached per client and invalidated by any edit to
 * the connection, so a "test connection" and the next RFQ see the same config.
 *
 * A tenant with no connection row gets the mock driver on default settings —
 * which is what every tenant did before this phase, and keeps a freshly created
 * workspace working before anyone has visited the SAP screen.
 */
const getSapAdapterForClient = async (clientId) => {
  if (!clientId) throw new Error('getSapAdapterForClient requires a clientId');

  const connection = await loadConnection(clientId);
  const key = cacheKey(connection);
  const hit = cache.get(clientId);

  if (hit && hit.key === key && Date.now() - hit.builtAt < ADAPTER_TTL_MS) return hit.adapter;

  const secrets = connection ? await decryptSecrets(connection) : {};
  const adapter = buildAdapter({ clientId, connection, secrets });
  cache.set(clientId, { adapter, key, builtAt: Date.now() });
  return adapter;
};

/**
 * Drops a tenant's cached adapter. The console calls this after a configuration
 * change so the next call picks up the new settings without waiting out the TTL
 * — belt and braces alongside the revision in the cache key.
 */
const invalidateSapAdapter = (clientId) => {
  if (clientId) cache.delete(clientId);
  else cache.clear();
};

/**
 * Builds a throwaway adapter from an unsaved configuration. This is what "Test
 * connection" uses: an operator must be able to prove credentials work
 * *before* committing them, and the test must not disturb the adapter the
 * tenant's live traffic is using.
 */
const buildTransientAdapter = ({ clientId, driver, config, secrets }) =>
  buildAdapter({
    clientId,
    connection: { driver, config, environment: 'sandbox' },
    secrets: secrets || {},
  });

module.exports = {
  getSapAdapterForClient,
  invalidateSapAdapter,
  buildTransientAdapter,
};
