const router = require('express').Router();
const reportsController = require('../controllers/reports.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/statement', requirePermission(PERMISSIONS.REPORT_READ), reportsController.generateStatement);
router.get('/invoice/:id', requirePermission(PERMISSIONS.REPORT_READ), reportsController.generateInvoicePDF);
router.get('/metrics', requirePermission(PERMISSIONS.REPORT_METRICS), reportsController.getPlatformMetrics);

module.exports = router;
