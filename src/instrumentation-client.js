import Monitor from '@/lib/monitoring';

// Browser-side error tracking, initialised before React hydrates
// (go-live item 3.x).
//
// `instrumentation-client.js` is Next's own hook for this — it runs after the
// document loads, before hydration, and before any interaction is possible,
// which is the only point early enough to catch an error thrown during
// hydration itself. A `useEffect` in the root layout would miss exactly those.
//
// Next warns in development if this file takes longer than 16ms, so there is
// nothing here but the init call: `Monitor.initialize()` returns immediately
// when NEXT_PUBLIC_SENTRY_DSN is unset (development, CI, and any deployment
// that has not configured it), and the SDK is a dynamic import inside it, so
// its chunk is not even fetched in that case. Not awaited: init is
// fire-and-forget, and it never rejects.
Monitor.initialize();

// Navigation breadcrumbs, which are the one piece of context worth having and
// the one the Breadcrumbs integration is switched off for — that integration
// patches fetch and would record request bodies, and this portal's forms carry
// bank details.
//
// `url` only. No query string handling is needed: this app's routes address
// documents by id in the path, and an id is what makes an error findable.
export function onRouterTransitionStart(url, navigationType) {
  try {
    // Itself a no-op when reporting is disabled.
    Monitor.breadcrumb({ url, navigationType });
  } catch {
    // Instrumentation must never break navigation.
  }
}
