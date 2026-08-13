const router = require('express').Router();
const { getDashboardSummary } = require('../controllers/dashboard.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/summary', requirePermission(PERMISSIONS.DASHBOARD_READ), getDashboardSummary);

module.exports = router;
