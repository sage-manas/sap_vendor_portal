const router = require('express').Router();
const validate = require('../middleware/validate');
const { settingsPatchSchema } = require('../validators/workspace.validator');
const workspace = require('../controllers/workspace.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

// The tenant back office. Mounted behind `protect`, so every handler already
// runs inside a bound tenant — which is why nothing here takes a clientId.
router.get('/overview', requirePermission(PERMISSIONS.WORKSPACE_READ), workspace.getOverview);
router.get('/settings', requirePermission(PERMISSIONS.SETTINGS_READ), workspace.getSettings);
router.patch('/settings', requirePermission(PERMISSIONS.SETTINGS_MANAGE), validate(settingsPatchSchema), workspace.updateSettings);
router.get('/audit', requirePermission(PERMISSIONS.AUDIT_READ), workspace.listAudit);

module.exports = router;
