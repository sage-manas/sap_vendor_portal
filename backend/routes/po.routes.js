const router = require('express').Router();
const {
  getPOs,
  getPOById,
  acknowledgePO,
  submitASN,
  getASNForPO,
  getSapPoStatus,
  createAssetPo,
  getInvoicePlan,
  configureInvoicePlan,
  removeInvoicePlan,
  setInvoicePlanLineBlock,
  syncInvoicePlan,
  proposeInvoicePlanChange,
  approveInvoicePlanChange,
  rejectInvoicePlanChange,
} = require('../controllers/po.controller');

const validate = require('../middleware/validate');
const validateQuery = require('../middleware/validateQuery');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { asnCreateSchema } = require('../validators/asn.validator');
const { invoicePlanSchema, invoicePlanLineBlockSchema, rejectInvoicePlanChangeSchema } = require('../validators/invoicePlan.validator');
const { assetPoSchema } = require('../validators/assetPo.validator');
const { paginationSchema } = require('../validators/pagination.validator');

router.get('/', requirePermission(PERMISSIONS.PO_READ), validateQuery(paginationSchema), getPOs);
// Must come before ':id' — 'sap-status' would otherwise be swallowed as a PO id.
router.get('/sap-status', requirePermission(PERMISSIONS.PO_READ), getSapPoStatus);
// The one endpoint in this application that creates a document in SAP
// (ADR-0042). Behind po:manage, which no supplier role holds: raising capex is
// the buying organisation's decision, and a supplier must never be able to
// originate an order against themselves. Must come before ':id' for the same
// reason as 'sap-status' above.
router.post('/asset', requirePermission(PERMISSIONS.PO_MANAGE), validate(assetPoSchema), createAssetPo);
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
// A supplier proposing a change to their own PO's plan — never a write to
// SAP itself (po:invoice-plan:propose is a distinct permission from
// po:manage precisely so this cannot reach SAP on its own). Approving or
// rejecting the proposal is still the buying organisation's decision.
router.put('/:id/items/:line/invoice-plan/propose', requirePermission(PERMISSIONS.PO_INVOICE_PLAN_PROPOSE), validate(invoicePlanSchema), proposeInvoicePlanChange);
router.put('/:id/items/:line/invoice-plan/propose/approve', requirePermission(PERMISSIONS.PO_MANAGE), approveInvoicePlanChange);
router.put('/:id/items/:line/invoice-plan/propose/reject', requirePermission(PERMISSIONS.PO_MANAGE), validate(rejectInvoicePlanChangeSchema), rejectInvoicePlanChange);
router.put('/:id/acknowledge', requirePermission(PERMISSIONS.PO_ACKNOWLEDGE), acknowledgePO);
// No PUT /:id/status: PurchaseOrder.status is derived, never written directly
// (issue #60) — see db/poHelpers.js's syncPoStatus.
router.post('/:id/asn', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCreateSchema), submitASN);
router.get('/:id/asn', requirePermission(PERMISSIONS.ASN_READ), getASNForPO);

module.exports = router;
