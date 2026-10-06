const logger = require('../utils/logger');
const { redactDeep, redactString } = require('../utils/redact');

// Error tracking for the two backend processes (go-live item 3.x).
//
// Before this, an unexpected 500 went to `backend/logs` and nowhere else.
// Nobody is tailing those at 02:00, logs rotate, and the job worker is a
// separate PM2 process whose crashes are invisible from the API's files — so
// the practical situation was that a production exception was discovered by a
// customer reporting it.
//
// Three things about this integration are deliberate.
//
// **It is disabled unless SENTRY_DSN is set.** Development, CI and every test
// run have no DSN, so `report()` is a no-op there and nothing is sent
// anywhere. That is also the honest default for a self-hosted deployment that
// has not signed up for anything: the feature arrives switched off rather
// than failing loudly about a missing account.
//
// **It uses @sentry/node directly, not Sentry's auto-instrumentation.**
// `Sentry.init()` with default integrations patches http, express, Postgres
// and more, and starts sending performance traces. This project has one SAP
// gateway behind a circuit breaker and a Prisma client wrapped in three
// extensions; silently patching that layer to collect spans nobody asked for
// is a large behavioural change to buy a feature the finding did not request.
// So: errors only, no tracing, no auto-patching, and one explicit call from
// the error handler. `tracesSampleRate` is 0 and `defaultIntegrations` is
// off, which is what makes that true rather than aspirational.
//
// **Everything is redacted first.** utils/redact.js is the one place that
// decides what must not leave this process (issue #128's sibling work), and
// Sentry is a third party — the single most important place for that rule to
// hold. A supplier's bank account number or PAN reaching a SaaS error tracker
// is the same leak as it reaching a log file, with a vendor agreement
// attached.

const DSN = () => String(process.env.SENTRY_DSN || '').trim();

let client = null;
let initialised = false;

// `release` and `environment` are what make two deploys distinguishable in
// Sentry's UI. Both are plain env vars rather than anything read from git:
// the running container has no repository, and a release string invented at
// runtime (a timestamp, say) groups nothing usefully.
const environment = () => process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
const release = () => process.env.SENTRY_RELEASE || undefined;

/**
 * Initialises error reporting, once per process. Safe to call when no DSN is
 * configured — it returns false and everything downstream becomes a no-op.
 *
 * `serviceName` distinguishes the API from the job worker, which are separate
 * PM2 processes with very different failure modes.
 */
const initSentry = ({ serviceName = 'api' } = {}) => {
  if (initialised) return Boolean(client);
  initialised = true;

  const dsn = DSN();
  if (!dsn) {
    logger.info('[observability] SENTRY_DSN is not set — error reporting is disabled');
    return false;
  }

  let Sentry;
  try {
    // Required lazily so a deployment that does not use Sentry does not pay
    // the import, and so a broken/absent package degrades to "reporting off"
    // rather than preventing the server from booting. An observability tool
    // must never be the reason the application is down.
    Sentry = require('@sentry/node');
  } catch (error) {
    logger.error(`[observability] SENTRY_DSN is set but @sentry/node could not be loaded: ${error.message}`);
    return false;
  }

  try {
    Sentry.init({
      dsn,
      environment: environment(),
      release: release(),
      // Errors only — see the header. Not a default worth inheriting.
      tracesSampleRate: 0,
      profilesSampleRate: 0,
      defaultIntegrations: false,
      // Breadcrumbs are collected by patching console and http, which is the
      // auto-instrumentation this integration is avoiding. The structured log
      // line is already written for every error, with a requestId to join on.
      maxBreadcrumbs: 0,
      // Last line of defence. Everything is redacted before it is handed over
      // (see `report`), and this catches anything the SDK assembles itself —
      // a server name, an env var it decided to attach.
      beforeSend: (event) => {
        try {
          return redactDeep(event);
        } catch (error) {
          // A redaction failure must drop the event, not send it unredacted.
          logger.error(`[observability] dropping a Sentry event: redaction failed: ${error.message}`);
          return null;
        }
      },
    });

    Sentry.setTag('service', serviceName);
    client = Sentry;
    logger.info(`[observability] error reporting enabled for ${serviceName} (${environment()})`);
    return true;
  } catch (error) {
    logger.error(`[observability] Sentry init failed, continuing without it: ${error.message}`);
    client = null;
    return false;
  }
};

/**
 * Reports one error. A no-op when reporting is disabled.
 *
 * `context` is arbitrary structured data (requestId, clientId, the route) and
 * is redacted before it leaves. Never throws: a failure to report an error
 * must not become a second error on the same request.
 */
const report = (error, context = {}) => {
  if (!client) return false;

  try {
    client.withScope((scope) => {
      // `requestId` is the join key back to the structured log line, which
      // holds the detail this event deliberately does not.
      if (context.requestId) scope.setTag('requestId', String(context.requestId));
      // The tenant, as an id. Never a company name or slug — the same rule
      // controllers/status.controller.js states for the public status page.
      if (context.clientId) scope.setTag('clientId', String(context.clientId));
      if (context.route) scope.setTag('route', String(context.route));

      const { requestId, clientId, route, ...rest } = context;
      if (Object.keys(rest).length) scope.setContext('detail', redactDeep(rest));

      client.captureException(redactedError(error));
    });
    return true;
  } catch (failure) {
    logger.error(`[observability] could not report an error: ${failure.message}`);
    return false;
  }
};

// An error's own message and stack are free text, and free text is where a
// GSTIN or an IFSC shows up — a SAP driver error quotes the payload it sent,
// and a Prisma error quotes the values it was given. redactString finds the
// shaped identifiers; the structured context above is handled by redactDeep.
//
// A new Error is built rather than mutating the caught one, because the caller
// still has to log and respond with it and must not see a rewritten message.
const redactedError = (error) => {
  if (!(error instanceof Error)) {
    return new Error(redactString(String(error)));
  }

  const copy = new Error(redactString(error.message || 'Unknown error'));
  copy.name = error.name;
  copy.stack = error.stack ? redactString(error.stack) : undefined;
  // Carried through so Sentry groups by the same code the API answers with.
  if (error.code) copy.code = error.code;
  return copy;
};

const isEnabled = () => Boolean(client);

// Tests only: lets a suite assert both the enabled and disabled paths without
// a module registry reset, and guarantees no state leaks between them.
const resetForTests = () => {
  client = null;
  initialised = false;
};

module.exports = { initSentry, report, isEnabled, resetForTests, redactedError };
