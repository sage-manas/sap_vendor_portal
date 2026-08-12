const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure upload directory exists inside backend
const uploadDirBase = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDirBase)) {
  fs.mkdirSync(uploadDirBase, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Dynamically store by vendor ID
    // The authenticated principal decides the folder — never a request header.
    // Sanitised because a tenant user may name the supplier in the body.
    const rawVendorId = req.scopeVendorId || req.body?.vendorId || 'shared';
    const vendorId = String(rawVendorId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const finalDir = path.join(uploadDirBase, vendorId);
    
    if (!fs.existsSync(finalDir)) {
      fs.mkdirSync(finalDir, { recursive: true });
    }
    cb(null, finalDir);
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
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB general limit (specific image limits checked in controller/frontend)
  }
});

module.exports = upload;
