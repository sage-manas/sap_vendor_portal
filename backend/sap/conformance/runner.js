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

// A deferred method never returns a promise itself — it schedules work and
// calls a handler later (a timer today, a poll or a webhook for a real
// driver). The suite has no document to persist, so it hands back whatever
// the driver answered with as if it had been persisted, which is enough to
// let the adapter's own bookkeeping (SapLog, the resolved PENDING entry) run
// for real.
const runDeferred = (adapter, method, args, timeoutMs) =>
  withTimeout(new Promise((resolve, reject) => {
    try {
      adapter[method](args, async (data) => {
        resolve(data);
        return data;
      });
    } catch (error) {
      reject(error);
    }
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
