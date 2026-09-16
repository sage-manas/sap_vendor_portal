const router = require('express').Router();
const {
  getInvoices,
  getInvoiceById,
  updateInvoiceStatus,
  getSapInvoiceStatus
} = require('../controllers/invoice.controller');

const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/', requirePermission(PERMISSIONS.INVOICE_READ), getInvoices);
// Must come before ':id' — 'sap-status' would otherwise be swallowed as an invoice id.
router.get('/sap-status', requirePermission(PERMISSIONS.INVOICE_READ), getSapInvoiceStatus);
router.get('/:id', requirePermission(PERMISSIONS.INVOICE_READ), getInvoiceById);
router.put('/:id/status', requirePermission(PERMISSIONS.INVOICE_APPROVE), updateInvoiceStatus);

module.exports = router;
