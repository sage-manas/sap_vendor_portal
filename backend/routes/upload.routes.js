const router = require('express').Router();
const fs = require('fs');
const validate = require('../middleware/validate');
const { noBody } = require('../validators/common.validator');
const { uploadFieldsSchema } = require('../validators/upload.validator');
const uploadController = require('../controllers/upload.controller');
const upload = require('../middleware/upload');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

// multer has written the file before the body is checked, so a request the
// schema refuses would otherwise leave an orphan on disk with no Document row.
const removeRejectedUpload = (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 400 && req.file) fs.rm(req.file.path, { force: true }, () => {});
  });
  next();
};

router.post('/', requirePermission(PERMISSIONS.DOCUMENT_WRITE), upload.single('file'), removeRejectedUpload, validate(uploadFieldsSchema), uploadController.uploadFile);
router.get('/', requirePermission(PERMISSIONS.DOCUMENT_READ), uploadController.listDocuments);
router.get('/:id', requirePermission(PERMISSIONS.DOCUMENT_READ), uploadController.downloadFile);
router.delete('/:id', requirePermission(PERMISSIONS.DOCUMENT_DELETE), validate(noBody), uploadController.deleteDocument);

module.exports = router;
