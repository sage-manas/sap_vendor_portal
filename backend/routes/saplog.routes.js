const router = require('express').Router();
const saplogController = require('../controllers/saplog.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/', requirePermission(PERMISSIONS.SAPLOG_READ), saplogController.listSapLogs);

module.exports = router;
