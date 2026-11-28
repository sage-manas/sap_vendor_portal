const router = require('express').Router();
const {
  getASNs, submitAsnMulti, cancelAsnById, approveAsn, rejectAsn, updateAsn,
} = require('../controllers/po.controller');
const { getAsnMonitor, retryAsnSap } = require('../controllers/asnMonitor.controller');
const { noBody } = require('../validators/common.validator');
const { requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const validateQuery = require('../middleware/validateQuery');
const { paginationSchema } = require('../validators/pagination.validator');
const { asnCreateMultiSchema, asnCancelSchema } = require('../validators/asn.validator');
const { PERMISSIONS } = require('../config/permissions');

// Finding 4.1: now paginated like every other list route, and reachable by
// tenant staff rather than suppliers only — see the note on getASNs. The
// permission gate is unchanged; ASN_READ is already held by the staff roles
// that could not previously get an answer out of this endpoint.
router.get('/', requirePermission(PERMISSIONS.ASN_READ), validateQuery(paginationSchema), getASNs);
// The buying organisation's monitor (ASN design B1). Before '/:asnId' routes.
// workspace:read as well: it is tenant-wide, and a supplier holds asn:read.
router.get('/monitor', requirePermission(PERMISSIONS.WORKSPACE_READ), requirePermission(PERMISSIONS.ASN_READ), getAsnMonitor);

// A shipment across one or more of the supplier's orders for one plant (ASN
// design V2). POST /pos/:id/asn stays for a shipment against one order.
router.post('/', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCreateMultiSchema), submitAsnMulti);
router.post('/:asnId/cancel', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCancelSchema), cancelAsnById);
// Change a sent shipment notice (ASN design D6): the whole shipment again,
// in the shape POST /asns takes.
router.put('/:asnId', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCreateMultiSchema), updateAsn);

// The tenant admin's decision, when the workspace requires one
// (shipments.asnApprovalRequired). A reason is required to reject, the same
// shape as a cancel's.
router.post('/:asnId/approve', requirePermission(PERMISSIONS.ASN_APPROVE), validate(noBody), approveAsn);
router.post('/:asnId/retry', requirePermission(PERMISSIONS.ASN_APPROVE), validate(noBody), retryAsnSap);
router.post('/:asnId/reject', requirePermission(PERMISSIONS.ASN_APPROVE), validate(asnCancelSchema), rejectAsn);

module.exports = router;
