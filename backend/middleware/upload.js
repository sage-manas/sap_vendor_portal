const multer = require('multer');
const path = require('path');
const { activeStorage } = require('../storage');

// Multer only stages the upload on disk so it can be inspected (content type,
// size, optional virus scan). Where it is staged, and whether that is also its
// final home, is the active storage driver's decision (storage/): the local
// driver keeps it, object storage uploads it and removes the staged copy.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // The authenticated principal decides the folder — never a request header.
    // Sanitised by the driver because a tenant user may name the supplier in the body.
    const rawVendorId = req.scopeVendorId || req.body?.vendorId || 'shared';
    cb(null, activeStorage().stagingDir(rawVendorId));
  },
  filename: (req, file, cb) => {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${sanitized}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.xlsx'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${ext} is not allowed. Allowed types: pdf, doc, docx, jpg, jpeg, png, xlsx`), false);
  }
};

const upload = multer({
  storage,
  // busboy reads a part's filename as latin1 unless told otherwise, so every
  // non-ASCII name (browsers send UTF-8) was stored as mojibake.
  defParamCharset: 'utf8',
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB general limit (specific image limits checked in controller/frontend)
  }
});

module.exports = upload;
