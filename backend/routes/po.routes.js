const router = require('express').Router();
const {
  getPOs,
  getPOById,
  acknowledgePO,
  simulatePO,
  submitASN,
  getASNForPO,
  updatePOStatus
} = require('../controllers/po.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { asnCreateSchema } = require('../validators/asn.validator');

router.get('/', requirePermission(PERMISSIONS.PO_READ), getPOs);
router.post('/simulate', requirePermission(PERMISSIONS.PO_CREATE), simulatePO);
router.get('/:id', requirePermission(PERMISSIONS.PO_READ), getPOById);
router.put('/:id/acknowledge', requirePermission(PERMISSIONS.PO_ACKNOWLEDGE), acknowledgePO);
router.put('/:id/status', requirePermission(PERMISSIONS.PO_MANAGE), updatePOStatus);
router.post('/:id/asn', requirePermission(PERMISSIONS.ASN_CREATE), validate(asnCreateSchema), submitASN);
router.get('/:id/asn', requirePermission(PERMISSIONS.ASN_READ), getASNForPO);

module.exports = router;
