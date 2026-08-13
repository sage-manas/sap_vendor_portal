const router = require('express').Router();
const { getASNs } = require('../controllers/po.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/', requirePermission(PERMISSIONS.ASN_READ), getASNs);

module.exports = router;
