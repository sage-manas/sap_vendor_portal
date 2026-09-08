const router = require('express').Router();
const ApiError = require('../utils/ApiError');
const { rawPrisma } = require('../db/prisma');
const { protect } = require('../middleware/auth');
const { tenantLimiter } = require('../middleware/rateLimiter');
const requireOnboarded = require('../middleware/requireOnboarded');

// One tenant's traffic must not be able to starve another's, or the server
// itself, on a shared deployment — `tenantLimiter` is keyed on `req.clientId`
// and can only run after `protect` has bound it (see middleware/rateLimiter.js).
const protectTenant = [protect, tenantLimiter];

// The transacting modules, which a supplier reaches only once they have
// submitted their registration (middleware/requireOnboarded.js). Tenant staff
// are unaffected. `/vendors`, `/uploads` and `/dashboard` are deliberately not
// in this list: they are the registration form, the documents it collects, and
// the shell it is rendered in.
const protectOnboarded = [...protectTenant, requireOnboarded];

router.get('/health', async (req, res) => {
  const io = req.app.get('io');
  let dbConnected = false;
  try {
    await rawPrisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch {
    dbConnected = false;
  }
  res.json({
    status: "healthy",
    db: dbConnected ? "connected" : "disconnected",
    socketConnections: io ? io.sockets.sockets.size : 0,
    sapMockMode: process.env.SAP_MOCK_MODE === 'true' ? "Mock Mode" : "Live",
    timestamp: new Date().toISOString()
  });
});

router.get('/test-error', (req, res, next) => {
  next(ApiError.badRequest('This is a test error to verify errorHandler'));
});

// Public status page — see controllers/status.controller.js for why it is
// deliberately anonymous (aggregate counts, never a tenant name or clientId).
router.get('/status', require('../controllers/status.controller').status);

// Auth routes. The public arms establish identity; /me and /change-password
// carry their own guard.
router.use('/auth', require('./auth.routes'));

// Platform plane — its own guard, and deliberately no tenant binding.
router.use('/platform', require('./platform.routes'));

// Tenant + supplier planes. `protect` binds the tenant; every route inside
// declares the permission it needs (config/permissions.js decides who holds it).
router.use('/vendors', require('./vendor.routes'));
router.use('/workspace', protectTenant, require('./workspace.routes'));
router.use('/users', protectTenant, require('./user.routes'));
router.use('/rfqs', protectOnboarded, require('./rfq.routes'));
router.use('/pos', protectOnboarded, require('./po.routes'));
router.use('/grns', protectOnboarded, require('./grn.routes'));
router.use('/invoices', protectOnboarded, require('./invoice.routes'));
router.use('/payments', protectOnboarded, require('./payment.routes'));
router.use('/chats', protectOnboarded, require('./chat.routes'));
router.use('/uploads', protectTenant, require('./upload.routes'));
router.use('/reports', protectOnboarded, require('./report.routes'));
router.use('/asns', protectOnboarded, require('./asn.routes'));
router.use('/logs', protectOnboarded, require('./saplog.routes'));
router.use('/dashboard', protectTenant, require('./dashboard.routes'));

module.exports = router;
