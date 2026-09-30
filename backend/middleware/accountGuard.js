const crypto = require('crypto');
const ApiError = require('../utils/ApiError');

// Per-account throttling for the endpoints an attacker uses to get into, or
// take over, one particular account: login, forgot-password, reset-password.
//
// The per-IP limiter cannot do this job. An office behind one NAT address needs
// a generous IP ceiling, which is far more than an attacker needs to guess at a
// single account; and a distributed attacker is many addresses. What is scarce
// for the attacker is attempts *against one identifier*, so that is what is
// counted.
//
//   attempts 1..freeAttempts        answered normally
//   attempts after that             answered progressively slower (base, 2x, 4x
//                                   … up to maxDelay)
//   lockAfter attempts              the identifier is locked for lockMs: 429 and
//                                   Retry-After, even for the right password
//
// The key is the normalised identifier whether or not an account exists, so a
// lockout (like the delay) is the same for a real account and a made-up one and
// says nothing about which is which.
//
// The cost is that anyone can lock a known identifier by failing against it.
// That is the standard trade of an account lockout; it is bounded to 15 minutes
// and does not touch any other account.
//
// State is in process memory. A restart clears it and a second API instance
// would have its own counters: fine for the current single-node deployment,
// and the store is the one thing to move to Redis if that changes.

const numberFromEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

// Read per call, not at load, so a test (or an operator with a reload) can
// change them.
const settings = (overrides = {}) => ({
  freeAttempts: overrides.freeAttempts ?? numberFromEnv('AUTH_FREE_ATTEMPTS', 5),
  lockAfter: overrides.lockAfter ?? numberFromEnv('AUTH_LOCKOUT_AFTER', 10),
  lockMs: numberFromEnv('AUTH_LOCKOUT_MS', 15 * 60 * 1000),
  baseDelayMs: numberFromEnv('AUTH_DELAY_BASE_MS', 500),
  maxDelayMs: numberFromEnv('AUTH_DELAY_MAX_MS', 8000),
});

const store = new Map(); // key -> { failures, lockedUntil, touchedAt }

const resetAccountGuards = () => store.clear();

// Entries are only interesting while they could still matter; without this a
// stream of distinct made-up identifiers would grow the map for ever.
const sweep = () => {
  const { lockMs } = settings();
  const cutoff = Date.now() - lockMs;
  for (const [key, state] of store) {
    if (state.touchedAt < cutoff && state.lockedUntil < Date.now()) store.delete(key);
  }
};
setInterval(sweep, 5 * 60 * 1000).unref();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const lockedError = (res, msRemaining) => {
  const seconds = Math.max(1, Math.ceil(msRemaining / 1000));
  res.set('Retry-After', String(seconds));
  const minutes = Math.ceil(seconds / 60);
  return new ApiError(429, `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
};

/**
 * @param scope         namespaces the counters (login and platform login must not share)
 * @param identify      req -> the raw identifier, or falsy to skip the guard
 * @param failureStatus the response status that means "that was a wrong guess"
 *                      (401 for login, 400 for a bad reset token). Any other
 *                      non-2xx response is not a guess and is not held against
 *                      the identifier.
 * @param countEvery    count every request as an attempt and never forgive
 *                      (forgot-password: there is no wrong answer to it).
 */
const accountGuard = ({ scope, identify, failureStatus = 401, countEvery = false, freeAttempts, lockAfter }) =>
  async (req, res, next) => {
    const raw = identify(req);
    if (!raw) return next();

    const key = `${scope}:${raw}`;
    const config = settings({ freeAttempts, lockAfter });
    const now = Date.now();

    let state = store.get(key);
    if (state && state.lockedUntil > now) {
      return next(lockedError(res, state.lockedUntil - now));
    }
    // An old record, or a lock that has run out, starts from nothing.
    if (!state || state.touchedAt < now - config.lockMs || (state.lockedUntil && state.lockedUntil <= now)) {
      state = { failures: 0, lockedUntil: 0, touchedAt: now };
      store.set(key, state);
    }

    const prior = state.failures;
    // Reached the limit on an earlier attempt (possibly one still in flight):
    // this one is refused rather than answered.
    if (prior >= config.lockAfter) {
      state.lockedUntil = now + config.lockMs;
      return next(lockedError(res, config.lockMs));
    }

    // Counted on arrival, not on completion, so a burst of parallel guesses
    // cannot all slip in ahead of the first one finishing.
    state.failures += 1;
    state.touchedAt = now;

    res.on('finish', () => {
      const current = store.get(key);
      if (!current || countEvery) return;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        store.delete(key);
      } else if (res.statusCode !== failureStatus) {
        // Not a wrong guess (an inactive account, a server error): not counted.
        current.failures = Math.max(0, current.failures - 1);
      }
    });

    if (prior >= config.freeAttempts && config.baseDelayMs > 0) {
      await sleep(Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (prior - config.freeAttempts)));
    }
    return next();
  };

const normalise = (value) => String(value ?? '').trim().toLowerCase();
const fingerprint = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 24);

// The guards as mounted on the routes.
const guards = {
  login: accountGuard({ scope: 'login', identify: (req) => normalise(req.body?.vendorIdOrEmail) }),
  platformLogin: accountGuard({ scope: 'platform-login', identify: (req) => normalise(req.body?.email) }),
  // Every request counts — the answer is always "if it exists we sent it". Five
  // is plenty for a person who mistyped and is waiting on the email.
  forgotPassword: accountGuard({
    scope: 'forgot', identify: (req) => normalise(req.body?.email), countEvery: true, freeAttempts: 3, lockAfter: 5,
  }),
  platformForgotPassword: accountGuard({
    scope: 'platform-forgot', identify: (req) => normalise(req.body?.email), countEvery: true, freeAttempts: 3, lockAfter: 5,
  }),
  // A reset has no identifier, only the token; what is worth limiting is
  // repeated attempts with one token.
  resetPassword: accountGuard({ scope: 'reset', identify: (req) => req.body?.token && fingerprint(req.body.token), failureStatus: 400 }),
  platformResetPassword: accountGuard({ scope: 'platform-reset', identify: (req) => req.body?.token && fingerprint(req.body.token), failureStatus: 400 }),
};

module.exports = { accountGuard, guards, resetAccountGuards };
