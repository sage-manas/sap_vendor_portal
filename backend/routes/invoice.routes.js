const router = require('express').Router();
const {
  getInvoices,
  getInvoiceById,
  submitInvoice,
  submitPlanInvoice,
  updateInvoiceStatus,
  getSapInvoiceStatus
} = require('../controllers/invoice.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { invoiceCreateSchema } = require('../validators/invoice.validator');
const { planInvoiceSchema } = require('../validators/invoicePlan.validator');

router.get('/', requirePermission(PERMISSIONS.INVOICE_READ), getInvoices);
router.post('/', requirePermission(PERMISSIONS.INVOICE_SUBMIT), validate(invoiceCreateSchema), submitInvoice);
// An invoice against one date of a PO line's invoicing plan. Separate from
// POST / because it has no goods receipt behind it and its amount comes from
// the plan, not from the request — a different document, not a variant.
// Above ':id' for the same reason as 'sap-status' below.
router.post('/plan', requirePermission(PERMISSIONS.INVOICE_SUBMIT), validate(planInvoiceSchema), submitPlanInvoice);
// Must come before ':id' — 'sap-status' would otherwise be swallowed as an invoice id.
router.get('/sap-status', requirePermission(PERMISSIONS.INVOICE_READ), getSapInvoiceStatus);
router.get('/:id', requirePermission(PERMISSIONS.INVOICE_READ), getInvoiceById);
router.put('/:id/status', requirePermission(PERMISSIONS.INVOICE_APPROVE), updateInvoiceStatus);

module.exports = router;
