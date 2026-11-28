const router = require('express').Router();
const {
  listDrafts, getDraft, createDraft, updateDraft, deleteDraft, submitDraft,
} = require('../controllers/asnDraft.controller');
const validate = require('../middleware/validate');
const { noBody } = require('../validators/common.validator');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { asnDraftSchema } = require('../validators/asn.validator');

// Drafts are the supplier's own unfinished shipment notices. Behind
// asn:create throughout, reads included: only a role that may raise a
// shipment has drafts of one, and staff roles hold asn:read but not this.
router.get('/', requirePermission(PERMISSIONS.ASN_CREATE), listDrafts);
router.post('/', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnDraftSchema), createDraft);
router.get('/:pk', requirePermission(PERMISSIONS.ASN_CREATE), getDraft);
router.put('/:pk', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnDraftSchema), updateDraft);
router.delete('/:pk', requirePermission(PERMISSIONS.ASN_CREATE), validate(noBody), deleteDraft);
router.post('/:pk/submit', requirePermission(PERMISSIONS.ASN_CREATE), validate(noBody), submitDraft);

module.exports = router;
