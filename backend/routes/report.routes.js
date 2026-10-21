const router = require('express').Router();
const reportsController = require('../controllers/reports.controller');
const reportExport = require('../controllers/reportExport.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

// The supplier's own report exports (issue #280). Every matching row, not a
// page of one — see controllers/reportExport.controller.js. They take no
// page/limit, which is why pagination-route-table.test.js lists them as
// generated files rather than collections.
router.get('/exports/spend-by-material', requirePermission(PERMISSIONS.REPORT_READ), reportExport.exportSpendByMaterial);
router.get('/exports/invoice-ageing', requirePermission(PERMISSIONS.REPORT_READ), reportExport.exportInvoiceAgeing);
router.get('/exports/account-ledger', requirePermission(PERMISSIONS.REPORT_READ), reportExport.exportAccountLedger);
router.get('/exports/tds', requirePermission(PERMISSIONS.REPORT_READ), reportExport.exportTds);

router.get('/statement', requirePermission(PERMISSIONS.REPORT_READ), reportsController.generateStatement);
router.get('/invoice/:id', requirePermission(PERMISSIONS.REPORT_READ), reportsController.generateInvoicePDF);
router.get('/metrics', requirePermission(PERMISSIONS.REPORT_METRICS), reportsController.getPlatformMetrics);

module.exports = router;
