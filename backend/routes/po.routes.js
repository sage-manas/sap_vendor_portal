const router = require('express').Router();
const {
  getPOs,
  getPOById,
  acknowledgePO,
  submitASN,
  getASNForPO,
  updatePOStatus,
  getSapPoStatus,
  getInvoicePlan,
  configureInvoicePlan,
  removeInvoicePlan,
  setInvoicePlanLineBlock,
  syncInvoicePlan
} = require('../controllers/po.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { asnCreateSchema } = require('../validators/asn.validator');
const { invoicePlanSchema, invoicePlanLineBlockSchema } = require('../validators/invoicePlan.validator');

router.get('/', requirePermission(PERMISSIONS.PO_READ), getPOs);
// Must come before ':id' — 'sap-status' would otherwise be swallowed as a PO id.
router.get('/sap-status', requirePermission(PERMISSIONS.PO_READ), getSapPoStatus);
router.get('/:id', requirePermission(PERMISSIONS.PO_READ), getPOById);

// Invoicing plans (FPLA/FPLT). Reading one is part of reading the order — a
// supplier has to see what they are allowed to bill. Configuring one is the
// buying organisation's decision, so it sits behind po:manage, which no
// supplier role holds.
router.get('/:id/invoice-plan', requirePermission(PERMISSIONS.PO_READ), getInvoicePlan);
router.post('/:id/invoice-plan/sync', requirePermission(PERMISSIONS.PO_MANAGE), syncInvoicePlan);
router.put('/:id/items/:line/invoice-plan', requirePermission(PERMISSIONS.PO_MANAGE), validate(invoicePlanSchema), configureInvoicePlan);
router.delete('/:id/items/:line/invoice-plan', requirePermission(PERMISSIONS.PO_MANAGE), removeInvoicePlan);
router.put('/:id/items/:line/invoice-plan/lines/:lineNumber/block', requirePermission(PERMISSIONS.PO_MANAGE), validate(invoicePlanLineBlockSchema), setInvoicePlanLineBlock);
router.put('/:id/acknowledge', requirePermission(PERMISSIONS.PO_ACKNOWLEDGE), acknowledgePO);
router.put('/:id/status', requirePermission(PERMISSIONS.PO_MANAGE), updatePOStatus);
router.post('/:id/asn', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCreateSchema), submitASN);
router.get('/:id/asn', requirePermission(PERMISSIONS.ASN_READ), getASNForPO);

module.exports = router;
