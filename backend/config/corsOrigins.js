// One origin policy, shared by the Express CORS handler, the Socket.io CORS
// handler and the helmet CSP. It used to be written out three times and had
// already drifted: both CORS copies accepted *any* http://localhost:<port>
// unconditionally, in production, next to `credentials: true`.
//
// Sessions live in localStorage rather than cookies, so that was not a
// session-theft path today — but it let any page served from a dev server on
// the victim's machine make credentialed calls to production, and it becomes
// genuinely exploitable the day auth moves to cookies.

// Any port, because a developer's tooling picks its own (vite preview, a
// throwaway `python -m http.server`, Storybook). Never consulted in production.
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

// The ports the app's own frontends actually run on in development.
const DEV_PORTS = [3000, 3001, 3002, 5173];

const isProduction = () => process.env.NODE_ENV === 'production';

// Read at call time, not at module load, so a process that sets NODE_ENV or
// ALLOWED_ORIGINS after requiring this still gets the right answer.
const configuredOrigins = () => [
  process.env.FRONTEND_URL,
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : []),
].map((origin) => origin && origin.trim()).filter(Boolean);

const devOrigins = () => (isProduction()
  ? []
  : DEV_PORTS.flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]));

const allowedOrigins = () => [...devOrigins(), ...configuredOrigins()];

// `origin + '/'` because a configured FRONTEND_URL is often written with a
// trailing slash, which browsers never send.
const isAllowedOrigin = (origin) => {
  if (!origin) return false;
  const allowed = allowedOrigins();
  if (allowed.includes(origin) || allowed.includes(`${origin}/`)) return true;
  return !isProduction() && LOOPBACK_ORIGIN.test(origin);
};

// helmet's CSP: same rule, expressed as a source list. No localhost entry
// survives into production.
const connectSrc = () => ["'self'", ...devOrigins(), ...configuredOrigins()];

module.exports = { allowedOrigins, isAllowedOrigin, connectSrc };
