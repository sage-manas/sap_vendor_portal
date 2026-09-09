const router = require('express').Router();
const {
  getRFQs,
  getRFQById,
  createRFQ,
  cancelRFQ,
  reissueRFQ,
  submitBid,
  getEvaluationMatrix,
  awardBid,
  getSapRfqStatus,
  getSapQuotationStatus,
  updateSapQuotationPrice,
  exportAwardedPo
} = require('../controllers/rfq.controller');

const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const {
  rfqCreateSchema,
  bidSchema,
  reissueRfqSchema,
  quotationPriceUpdateSchema
} = require('../validators/rfq.validator');

router.get('/', requirePermission(PERMISSIONS.RFQ_READ), getRFQs);
router.post('/', requirePermission(PERMISSIONS.RFQ_CREATE), validate(rfqCreateSchema), createRFQ);
// Must come before ':id' — 'sap-status' would otherwise be swallowed as an RFQ id.
router.get('/sap-status', requirePermission(PERMISSIONS.RFQ_READ), getSapRfqStatus);
router.get('/sap-quotations', requirePermission(PERMISSIONS.RFQ_READ), getSapQuotationStatus);
router.get('/:id', requirePermission(PERMISSIONS.RFQ_READ), getRFQById);
router.put('/:id/cancel', requirePermission(PERMISSIONS.RFQ_MANAGE), cancelRFQ);
router.put('/:id/reissue', requirePermission(PERMISSIONS.RFQ_MANAGE), validate(reissueRfqSchema), reissueRFQ);
router.post('/:id/bid', requirePermission(PERMISSIONS.RFQ_BID), validate(bidSchema), submitBid);
router.post('/:id/sap-quote-price', requirePermission(PERMISSIONS.RFQ_BID), validate(quotationPriceUpdateSchema), updateSapQuotationPrice);
router.get('/:id/evaluate', requirePermission(PERMISSIONS.RFQ_EVALUATE), getEvaluationMatrix);
router.post('/:id/award', requirePermission(PERMISSIONS.RFQ_AWARD), awardBid);
router.get('/:id/export', requirePermission(PERMISSIONS.RFQ_READ), exportAwardedPo);

module.exports = router;
