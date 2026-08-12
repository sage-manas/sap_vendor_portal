const router = require('express').Router();
const {
  getPayments,
  getPaymentById,
  createPayment,
  updatePaymentStatus
} = require('../controllers/payment.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/', requirePermission(PERMISSIONS.PAYMENT_READ), getPayments);
router.post('/', requirePermission(PERMISSIONS.PAYMENT_CREATE), createPayment);
router.get('/:id', requirePermission(PERMISSIONS.PAYMENT_READ), getPaymentById);
router.put('/:id/status', requirePermission(PERMISSIONS.PAYMENT_MANAGE), updatePaymentStatus);

module.exports = router;
