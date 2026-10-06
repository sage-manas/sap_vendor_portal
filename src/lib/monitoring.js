// Browser error tracking (go-live item 3.x).
//
// Three decisions, all of which are about what this does *not* do.
//
// **It is disabled unless NEXT_PUBLIC_SENTRY_DSN is set.** No DSN means every
// function here is a no-op, which is the state in development, in CI, and in a
// deployment that has not signed up for anything.
//
// **It uses @sentry/browser, not @sentry/nextjs.** The Next SDK wants
// `withSentryConfig` wrapped around next.config and its own generated
// instrumentation files, which couples the build to a vendor plugin — and this
// is a modified Next 16, where that plugin's assumptions are not safe to take
// on trust. The cost of avoiding it is real and worth stating: **no source-map
// upload and no release-artifact association**, so a stack trace from a
// production bundle will be minified. `release` is still tagged, so the maps
// can be uploaded out of band (sentry-cli) later if someone wants readable
// frames.
//
// **It sends no session replay, no performance tracing, and no PII.** This
// portal's screens hold a supplier's bank account number, PAN and GSTIN.
// Session replay would record them; `sendDefaultPii` would attach the URL,
// cookies and IP. Both are off, and `beforeSend` strips what is left — a
// third-party error tracker is the last place a payout account should appear.

// Read at call time, not import time, so a test can enable and disable it.
const dsn = () => String(process.env.NEXT_PUBLIC_SENTRY_DSN || '').trim();

let client = null;

// The shapes utils/redact.js matches on the server, kept in step with it by
// `src/lib/monitoring.test.js`, which feeds both the same identifiers.
// Duplicated rather than imported because `backend/` is a separate package the
// browser bundle cannot reach into.
const PATTERNS = [
  // PAN: AAAAA9999A
  [/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, '[REDACTED-PAN]'],
  // GSTIN: 15 characters, state code first
  [/\b[0-9]{2}[A-Z0-9]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, '[REDACTED-GSTIN]'],
  // IFSC: AAAA0999999
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, '[REDACTED-IFSC]'],
  // A bare run of 9-18 digits, which is what an account number looks like.
  // Deliberately blunt: a false positive costs a reviewer one unreadable
  // number in a stack trace, a false negative puts a payout account in a
  // third party's database.
  [/\b\d{9,18}\b/g, '[REDACTED-NUMBER]'],
];

const scrub = (text) => {
  if (typeof text !== 'string') return text;
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
};

// Walks an event, scrubbing every string. Depth-limited because a Sentry event
// can hold cyclic references and this runs on the user's main thread.
const scrubDeep = (value, depth = 0) => {
  if (depth > 8) return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubDeep(item, depth + 1)]));
  }
  return value;
};

const initialize = async () => {
  if (client || !dsn()) return false;

  try {
    // A dynamic import, not a module-scope one: the bundler splits it into its
    // own chunk, so a deployment without a DSN never ships the SDK's bytes. The
    // cost is that an error thrown before the chunk arrives is not captured.
    const Sentry = await import('@sentry/browser');

    Sentry.init({
      dsn: dsn(),
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
      // See the header: errors only.
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      // No URL, no cookies, no IP address. A supplier's own screens are
      // addressed by document id, and the ids are enough to find a record.
      sendDefaultPii: false,
      integrations: (defaults) => defaults.filter(
        // Breadcrumbs patch fetch, history and console; the fetch one would
        // record request bodies, which is where a bank-change form's payload
        // lives.
        (integration) => !['Breadcrumbs', 'BrowserTracing', 'Replay', 'GlobalHandlers'].includes(integration.name),
      ),
      beforeSend: (event) => {
        try {
          return scrubDeep(event);
        } catch {
          // Drop rather than send unscrubbed.
          return null;
        }
      },
    });

    client = Sentry;
    return true;
  } catch {
    // An observability tool must never be the reason a page fails to become
    // interactive. Swallowed on purpose, with no console noise: a visitor can
    // do nothing about it.
    return false;
  }
};

/** Reports one error. A no-op when no DSN is configured. */
const report = (error, context = {}) => {
  if (!client) return false;
  try {
    client.withScope((scope) => {
      scope.setContext('detail', scrubDeep(context));
      client.captureException(error);
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * Records a navigation breadcrumb by hand.
 *
 * The automatic Breadcrumbs integration is switched off (it patches fetch and
 * would capture request bodies — this portal's forms carry bank details), so
 * the one breadcrumb worth having is added explicitly. A no-op when no DSN is
 * configured.
 */
const breadcrumb = ({ url, navigationType }) => {
  if (!client) return false;
  try {
    client.addBreadcrumb({
      category: 'navigation',
      level: 'info',
      message: scrub(String(url ?? '')),
      data: { navigationType: String(navigationType ?? '') },
    });
    return true;
  } catch {
    return false;
  }
};

const isEnabled = () => Boolean(client);

// Tests only.
const resetForTests = () => { client = null; };

export default { initialize, report, breadcrumb, isEnabled, resetForTests, scrub, scrubDeep };
export { initialize, report, breadcrumb, isEnabled, resetForTests, scrub, scrubDeep };
