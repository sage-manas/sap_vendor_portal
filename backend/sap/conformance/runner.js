const { METHOD_NAMES, SAP_METHODS } = require('../contract');
const { runWithTenant } = require('../../utils/tenantContext');
const { FIXTURES } = require('./fixtures');

const DEFAULT_TIMEOUT_MS = 15000;

const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// A deferred method is a one-shot probe called once per job attempt
// (jobs/worker.js — see docs/04-sap-runtime-engineering-plan.md Phase 1): it
// resolves `false` with no handler call when SAP has no answer yet, `true`
// once `handler` has run and the wrapper has finished its own bookkeeping
// (SapLog, the resolved PENDING entry), or rejects on a genuine failure.
//
// Resolving on the *outer* `adapter[method](...)` promise rather than from
// inside the handler callback matters: `handler` runs partway through
// sap/index.js's wrapDeferred — the wrapper still has its own `recordSapCall`
// writes to make after `handler` returns, before the driver's returned
// promise itself settles. Resolving early (from inside the callback) would
// race ahead of those writes and under-count them nondeterministically. The
// suite has no document to persist, so it hands back whatever the driver
// answered with as if it had been persisted, which is enough to let the
// wrapper's bookkeeping run for real. A `false` resolution (nothing found on
// this one attempt — a real gateway or a longer timeoutMs is what would
// eventually produce an answer) is left pending deliberately: the race
// against `timeoutMs` below is what turns that into "timed out" rather than
// a real rejection winning first.
const runDeferred = (adapter, method, args, timeoutMs) =>
  withTimeout(new Promise((resolve, reject) => {
    let captured;
    Promise.resolve(adapter[method](args, async (data) => {
      captured = data;
      return data;
    }))
      .then((found) => {
        if (found) resolve(captured);
        // else: leave pending — see the note above.
      })
      .catch(reject);
  }), timeoutMs, `${method}()`);

/**
 * Runs the whole SapAdapter contract against a live adapter and reports
 * pass/fail per method. Phase 8's conformance suite: point it at the mock
 * driver and everything passes; point it at a skeleton and everything but
 * `testConnection`/`health` reports `not_implemented`; point it at a real
 * driver mid-build and the mix of the two *is* the progress report, without
 * anyone hand-maintaining a checklist alongside the code.
 *
 * @param {object} options
 * @param {object} options.adapter    a built SapAdapter (buildTransientAdapter or getSapAdapterForClient)
 * @param {string} [options.clientId] binds tenant context per call, so SapLog writes succeed; omit for a driver-only smoke test with no tenant of its own
 * @param {number} [options.timeoutMs]
 * @param {string[]} [options.methods] a subset of METHOD_NAMES, default all
 */
const runConformanceSuite = async ({ adapter, clientId, timeoutMs = DEFAULT_TIMEOUT_MS, methods = METHOD_NAMES }) => {
  const results = [];

  for (const method of methods) {
    const spec = SAP_METHODS[method];
    const args = FIXTURES[method] || {};
    const started = Date.now();

    const call = () => (spec.deferred
      ? runDeferred(adapter, method, args, timeoutMs)
      : withTimeout(Promise.resolve(adapter[method](args)), timeoutMs, `${method}()`));

    try {
      const data = clientId ? await runWithTenant(clientId, call) : await call();
      results.push({ method, transaction: spec.transaction, status: 'passed', durationMs: Date.now() - started, data });
    } catch (error) {
      results.push({
        method,
        transaction: spec.transaction,
        status: error.code === 'not_implemented' ? 'not_implemented' : 'failed',
        durationMs: Date.now() - started,
        error: error.message,
      });
    }
  }

  const summary = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  return { driver: adapter.driver, implemented: adapter.implemented, results, summary };
};

module.exports = { runConformanceSuite, DEFAULT_TIMEOUT_MS };
