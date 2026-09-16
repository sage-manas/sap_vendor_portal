const logger = require('../utils/logger');

// One circuit breaker per tenant connection.
//
// A tenant whose SAP gateway is down should fail fast and stop hammering it,
// and — the part that matters here — should not drag every other tenant's
// request latency along with it by holding connections open. The breaker is
// per adapter instance, so one tenant tripping is invisible to the rest.
//
// Three states, the usual ones:
//   closed    — calls pass through; consecutive failures are counted
//   open      — calls are refused immediately until `resetAfterMs` has passed
//   half-open — one call is let through; success closes, failure re-opens

const DEFAULTS = {
  failureThreshold: 5,
  resetAfterMs: 30000,
};

// Codes that must never count toward tripping the breaker — they answer a
// question about our own code or about a business fact, not about whether
// SAP itself is reachable (issue #70). `not_implemented` is thrown from
// *inside* the wrapped driver call, before sap/index.js's wrapImmediate ever
// gets a chance to re-throw it unwrapped, so without this the breaker was
// counting "we haven't built this method yet" the same as a real transport
// failure — five calls to an unbuilt ecc_rfc method opened the circuit for
// every other method on that tenant. `sap_not_found` is the same idea for a
// driver's honest "SAP has nothing here" (see contract.js's SapNotFoundError)
// — a 404-equivalent business answer, not an outage.
const EXEMPT_FAILURE_CODES = new Set(['not_implemented', 'sap_not_found']);

class CircuitOpenError extends Error {
  constructor(label, openedAt, resetAfterMs) {
    const waitMs = Math.max(0, resetAfterMs - (Date.now() - openedAt));
    super(`sap_circuit_open: ${label} has been failing; not retrying for another ${Math.ceil(waitMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.code = 'sap_circuit_open';
    this.statusCode = 503;
    this.retryAfterMs = waitMs;
  }
}

const createCircuitBreaker = ({ label, failureThreshold, resetAfterMs } = {}) => {
  const limit = failureThreshold ?? DEFAULTS.failureThreshold;
  const cooldown = resetAfterMs ?? DEFAULTS.resetAfterMs;

  let failures = 0;
  let state = 'closed';
  let openedAt = 0;
  let lastError = null;

  const trip = (error) => {
    state = 'open';
    openedAt = Date.now();
    lastError = error?.message || String(error);
    logger.warn(`[sap] circuit opened for ${label} after ${failures} consecutive failures: ${lastError}`);
  };

  const close = () => {
    if (state !== 'closed') logger.info(`[sap] circuit closed for ${label}`);
    state = 'closed';
    failures = 0;
    lastError = null;
  };

  return {
    get state() {
      // Reading the state is also how it expires: no timer is needed, and a
      // breaker on an idle tenant costs nothing.
      if (state === 'open' && Date.now() - openedAt >= cooldown) state = 'half-open';
      return state;
    },

    snapshot() {
      return { state: this.state, failures, lastError, openedAt: openedAt ? new Date(openedAt) : null };
    },

    async run(fn) {
      if (this.state === 'open') throw new CircuitOpenError(label, openedAt, cooldown);

      const wasHalfOpen = this.state === 'half-open';

      try {
        const result = await fn();
        close();
        return result;
      } catch (error) {
        // Classify before counting: a method that doesn't exist yet, or a
        // legitimate "not found" business answer, tells us nothing about
        // whether SAP is actually reachable, so it must not move the breaker
        // at all — not counted, not tripped, and (since nothing here mutates
        // `state`) a half-open probe that hits one of these stays half-open
        // for the next real call to actually test.
        if (EXEMPT_FAILURE_CODES.has(error?.code)) throw error;

        failures += 1;
        // A half-open probe that fails re-opens immediately: the system has
        // just told us it is still down, and waiting for four more failures to
        // agree would be pointless traffic.
        if (wasHalfOpen || failures >= limit) trip(error);
        throw error;
      }
    },
  };
};

module.exports = { createCircuitBreaker, CircuitOpenError, DEFAULTS };
