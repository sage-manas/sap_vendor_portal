const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again after 15 minutes',
    code: 429
  }
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20, // Limit each IP to 20 uploads per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many upload attempts from this IP, please try again after 10 minutes',
    code: 429
  }
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // Limit each IP to 50 webhook requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many webhook requests from this IP, please try again after a minute',
    code: 429
  }
});

// Per-tenant, not per-IP: `apiLimiter` protects the server from one noisy
// address, but a tenant behind a shared corporate NAT or an integration
// hitting the API from many addresses is invisible to it. Keyed on
// `req.clientId`, which is only set once `protect` has bound the tenant, so
// this must be mounted after it — never before, or every tenant would share
// one IP-keyed bucket. Falls back to the IP for the sliver of a request that
// reaches here without one, which should not happen but must not crash.
const tenantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.TENANT_RATE_LIMIT_MAX) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.clientId || ipKeyGenerator(req.ip),
  skip: () => process.env.NODE_ENV === 'test',
  message: {
    success: false,
    error: 'This workspace is making requests too quickly. Please slow down and try again shortly.',
    code: 429
  }
});

module.exports = {
  apiLimiter,
  uploadLimiter,
  webhookLimiter,
  tenantLimiter
};
