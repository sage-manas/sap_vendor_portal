const router = require('express').Router();
const { getGRNs, getGRNById } = require('../controllers/grn.controller');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const validateQuery = require('../middleware/validateQuery');
const { paginationSchema } = require('../validators/pagination.validator');

router.get('/', requirePermission(PERMISSIONS.GRN_READ), validateQuery(paginationSchema), getGRNs);
router.get('/:id', requirePermission(PERMISSIONS.GRN_READ), getGRNById);

module.exports = router;
