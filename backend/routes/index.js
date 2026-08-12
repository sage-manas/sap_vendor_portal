const router = require('express').Router();
const ApiError = require('../utils/ApiError');
const mongoose = require('mongoose');
const { protect } = require('../middleware/auth');

router.get('/health', (req, res) => {
  const io = req.app.get('io');
  res.json({
    status: "healthy",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    socketConnections: io ? io.sockets.sockets.size : 0,
    sapMockMode: process.env.SAP_MOCK_MODE === 'true' ? "Mock Mode" : "Live",
    timestamp: new Date().toISOString()
  });
});

router.get('/test-error', (req, res, next) => {
  next(ApiError.badRequest('This is a test error to verify errorHandler'));
});

// Auth routes. The public arms establish identity; /me and /change-password
// carry their own guard.
router.use('/auth', require('./auth.routes'));

// Platform plane — its own guard, and deliberately no tenant binding.
router.use('/platform', require('./platform.routes'));

// Tenant + supplier planes. `protect` binds the tenant; every route inside
// declares the permission it needs (config/permissions.js decides who holds it).
router.use('/vendors', require('./vendor.routes'));
router.use('/users', protect, require('./user.routes'));
router.use('/rfqs', protect, require('./rfq.routes'));
router.use('/pos', protect, require('./po.routes'));
router.use('/grns', protect, require('./grn.routes'));
router.use('/invoices', protect, require('./invoice.routes'));
router.use('/payments', protect, require('./payment.routes'));
router.use('/chats', protect, require('./chat.routes'));
router.use('/uploads', protect, require('./upload.routes'));
router.use('/reports', protect, require('./report.routes'));
router.use('/asns', protect, require('./asn.routes'));
router.use('/logs', protect, require('./saplog.routes'));
router.use('/dashboard', protect, require('./dashboard.routes'));

module.exports = router;
