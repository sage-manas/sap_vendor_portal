const router = require('express').Router();
const { getASNs } = require('../controllers/po.controller');
const { requirePermission } = require('../middleware/auth');
const validateQuery = require('../middleware/validateQuery');
const { paginationSchema } = require('../validators/pagination.validator');
const { PERMISSIONS } = require('../config/permissions');

// Finding 4.1: now paginated like every other list route, and reachable by
// tenant staff rather than suppliers only — see the note on getASNs. The
// permission gate is unchanged; ASN_READ is already held by the staff roles
// that could not previously get an answer out of this endpoint.
router.get('/', requirePermission(PERMISSIONS.ASN_READ), validateQuery(paginationSchema), getASNs);

module.exports = router;
