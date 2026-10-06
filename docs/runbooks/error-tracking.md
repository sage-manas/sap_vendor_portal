# Error tracking (Sentry)

Disabled until a DSN is set. With no DSN nothing is sent anywhere, including in dev and CI.

## Enable

| Process | Variable |
| --- | --- |
| API and job worker (`backend/.env`) | `SENTRY_DSN`, optional `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` |
| Browser (root `.env`, **build time**) | `NEXT_PUBLIC_SENTRY_DSN`, optional `NEXT_PUBLIC_SENTRY_ENVIRONMENT`, `NEXT_PUBLIC_SENTRY_RELEASE` |

`NEXT_PUBLIC_*` is inlined at build, so changing it needs a rebuild. Restart PM2 for the backend.

## What is sent

- **API**: 5xx only (4xx are deliberate refusals). Tags: `requestId`, `clientId`, `route`. Join to the log line on `requestId`.
- **Worker**: errors caught by the job tick, tagged `service=jobs`.
- **Browser**: uncaught errors via the SDK, plus navigation breadcrumbs.
- Errors only: no tracing, profiling, replay, auto-instrumentation or PII. PAN, GSTIN, IFSC, account numbers and secrets are redacted before leaving (`backend/utils/redact.js`, `src/lib/monitoring.js`).

## Known gaps

- No source-map upload: browser stack frames are minified. Upload with `sentry-cli` against `NEXT_PUBLIC_SENTRY_RELEASE` if needed.
- Errors thrown while the Next server renders are not captured (the Next process has no Sentry; the root package may not depend on `@sentry/node`, see `dependency-hygiene.test.js`).
- A browser error thrown before the SDK chunk loads is lost.
