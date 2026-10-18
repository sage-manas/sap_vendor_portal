const router = require('express').Router();
const { getDashboardSummary, getSapStatus } = require('../controllers/dashboard.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/summary', requirePermission(PERMISSIONS.DASHBOARD_READ), getDashboardSummary);
router.get('/sap-status', requirePermission(PERMISSIONS.DASHBOARD_READ), getSapStatus);

module.exports = router;
