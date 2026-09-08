const router = require('express').Router();
const {
  getPayments,
  getSapPaymentStatus,
  getTdsSummary,
  getPaymentById,
  createPayment,
  updatePaymentStatus
} = require('../controllers/payment.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/', requirePermission(PERMISSIONS.PAYMENT_READ), getPayments);
router.post('/', requirePermission(PERMISSIONS.PAYMENT_CREATE), createPayment);
// Ahead of '/:id', or Express would read "sap-status" as a payment id.
router.get('/sap-status', requirePermission(PERMISSIONS.PAYMENT_READ), getSapPaymentStatus);
router.get('/tds-summary', requirePermission(PERMISSIONS.PAYMENT_READ), getTdsSummary);
router.get('/:id', requirePermission(PERMISSIONS.PAYMENT_READ), getPaymentById);
router.put('/:id/status', requirePermission(PERMISSIONS.PAYMENT_MANAGE), updatePaymentStatus);

module.exports = router;
