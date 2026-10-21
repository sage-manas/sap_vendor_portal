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
// This workspace's own totals, not the platform's — see the handler's comment
// (issue #289). The path is left alone: it is a tenant-staff endpoint and
// renaming it would break any caller for no gain in accuracy.
router.get('/metrics', requirePermission(PERMISSIONS.REPORT_METRICS), reportsController.getTenantMetrics);

module.exports = router;
