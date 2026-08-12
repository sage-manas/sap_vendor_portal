const router = require('express').Router();
const {
  getRFQs,
  getRFQById,
  createRFQ,
  cancelRFQ,
  reissueRFQ,
  submitBid,
  getEvaluationMatrix,
  awardBid
} = require('../controllers/rfq.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const {
  rfqCreateSchema,
  bidSchema,
  reissueRfqSchema
} = require('../validators/rfq.validator');

router.get('/', requirePermission(PERMISSIONS.RFQ_READ), getRFQs);
router.post('/', requirePermission(PERMISSIONS.RFQ_CREATE), validate(rfqCreateSchema), createRFQ);
router.get('/:id', requirePermission(PERMISSIONS.RFQ_READ), getRFQById);
router.put('/:id/cancel', requirePermission(PERMISSIONS.RFQ_MANAGE), cancelRFQ);
router.put('/:id/reissue', requirePermission(PERMISSIONS.RFQ_MANAGE), validate(reissueRfqSchema), reissueRFQ);
router.post('/:id/bid', requirePermission(PERMISSIONS.RFQ_BID), validate(bidSchema), submitBid);
router.get('/:id/evaluate', requirePermission(PERMISSIONS.RFQ_EVALUATE), getEvaluationMatrix);
router.post('/:id/award', requirePermission(PERMISSIONS.RFQ_AWARD), awardBid);

module.exports = router;
