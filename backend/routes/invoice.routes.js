const router = require('express').Router();
const {
  getInvoices,
  getInvoiceById,
  submitInvoice,
  updateInvoiceStatus,
  postMiro
} = require('../controllers/invoice.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { invoiceCreateSchema } = require('../validators/invoice.validator');

router.get('/', requirePermission(PERMISSIONS.INVOICE_READ), getInvoices);
router.post('/', requirePermission(PERMISSIONS.INVOICE_SUBMIT), validate(invoiceCreateSchema), submitInvoice);
router.get('/:id', requirePermission(PERMISSIONS.INVOICE_READ), getInvoiceById);
router.put('/:id/status', requirePermission(PERMISSIONS.INVOICE_APPROVE), updateInvoiceStatus);
router.post('/:id/miro', requirePermission(PERMISSIONS.INVOICE_POST), postMiro);

module.exports = router;
