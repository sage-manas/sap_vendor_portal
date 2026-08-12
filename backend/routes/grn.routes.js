const router = require('express').Router();
const { getGRNs, getGRNById } = require('../controllers/grn.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.get('/', requirePermission(PERMISSIONS.GRN_READ), getGRNs);
router.get('/:id', requirePermission(PERMISSIONS.GRN_READ), getGRNById);

module.exports = router;
