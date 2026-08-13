const router = require('express').Router();
const uploadController = require('../controllers/upload.controller');
const upload = require('../middleware/upload');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

router.post('/', requirePermission(PERMISSIONS.DOCUMENT_WRITE), upload.single('file'), uploadController.uploadFile);
router.get('/', requirePermission(PERMISSIONS.DOCUMENT_READ), uploadController.listDocuments);
router.get('/:id', requirePermission(PERMISSIONS.DOCUMENT_READ), uploadController.downloadFile);
router.delete('/:id', requirePermission(PERMISSIONS.DOCUMENT_DELETE), uploadController.deleteDocument);

module.exports = router;
