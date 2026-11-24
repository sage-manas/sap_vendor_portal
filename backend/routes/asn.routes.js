const router = require('express').Router();
const {
  getASNs, submitAsnMulti, cancelAsnById, approveAsn, rejectAsn,
} = require('../controllers/po.controller');
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

// A shipment across one or more of the supplier's orders for one plant (ASN
// design V2). POST /pos/:id/asn stays for a shipment against one order.
router.post('/', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCreateMultiSchema), submitAsnMulti);
router.post('/:asnId/cancel', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCancelSchema), cancelAsnById);

// The tenant admin's decision, when the workspace requires one
// (shipments.asnApprovalRequired). A reason is required to reject, the same
// shape as a cancel's.
router.post('/:asnId/approve', requirePermission(PERMISSIONS.ASN_APPROVE), validate(noBody), approveAsn);
router.post('/:asnId/reject', requirePermission(PERMISSIONS.ASN_APPROVE), validate(asnCancelSchema), rejectAsn);

module.exports = router;
