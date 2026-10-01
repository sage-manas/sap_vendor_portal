const { prisma } = require('../db/prisma');
const fs = require('fs');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { assertCanCreate } = require('../utils/usage');
const { checkUpload, mimeForFileName, contentDisposition } = require('../utils/fileType');
const { refusalFor } = require('../services/virusScan.service');

const { requireVendorScope, vendorScope, scopedWhere } = require('../utils/requestScope');

// multer has already written the file by the time a controller runs, so every
// refusal below has to take it back off the disk — a request nothing will ever
// create a Document row for must not leave a file behind.
const discard = (file) => {
  try {
    fs.rmSync(file.path, { force: true });
  } catch (error) {
    logger.error(`[upload] could not remove ${file.path}: ${error.message}`);
  }
};

// @desc    Upload file and save document details
// @route   POST /api/uploads
// @access  document:write
const uploadFile = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);

  if (!req.file) {
    return next(ApiError.badRequest('No file uploaded'));
  }
  const { file } = req;

  // What the file is comes from its bytes, and must agree with its extension and
  // with what the client said it was (issue #124). The extension filter in
  // middleware/upload.js is only the first, cheap gate.
  const verdict = checkUpload({
    buffer: await fs.promises.readFile(file.path),
    originalName: file.originalname,
    declaredMime: file.mimetype,
  });
  if (verdict.error) {
    discard(file);
    return next(ApiError.badRequest(verdict.error, { reason: 'file_type_mismatch' }));
  }

  // Double check image sizes (max 5MB for images)
  if (verdict.mime.startsWith('image/') && file.size > 5 * 1024 * 1024) {
    discard(file);
    return next(ApiError.badRequest('Image file size exceeds 5MB limit'));
  }

  // The tenant's storage plan limit (issue #116).
  try {
    await assertCanCreate(req.client, 'storageMb', file.size / (1024 * 1024));
  } catch (error) {
    discard(file);
    return next(error);
  }

  // Optional ClamAV scan (CLAMAV_HOST); a no-op when not configured.
  const refusal = await refusalFor(file.path);
  if (refusal) {
    discard(file);
    return next(new ApiError(refusal.status, refusal.message));
  }

  const { linkedTo } = req.body;

  let doc;
  try {
    doc = await prisma.document.create({
      data: {
        vendorId,
        fileName: file.filename,
        originalName: file.originalname,
        // The type the server proved, never the one the client declared.
        mimeType: verdict.mime,
        size: file.size,
        filePath: file.path,
        linkedTo: linkedTo || 'Profile'
      },
    });
  } catch (error) {
    discard(file);
    throw error;
  }

  res.status(201).json({
    documentId: doc.pk,
    originalName: doc.originalName,
    fileName: doc.fileName,
    size: doc.size,
    url: `/api/uploads/${doc.pk}`
  });
});

// @desc    Download / view uploaded file
// @route   GET /api/uploads/:id
// @access  Public
const downloadFile = asyncHandler(async (req, res, next) => {
  const { id } = req.params;

  // A supplier reaches only their own documents, and someone else's is
  // indistinguishable from one that does not exist. Tenant staff reach any
  // document in their tenant â€” the tenant extension has already scoped the read.
  const doc = await prisma.document.findFirst({ where: scopedWhere(req, { pk: id }) });
  if (!doc) {
    return next(ApiError.notFound('Document not found'));
  }

  if (!fs.existsSync(doc.filePath)) {
    return next(ApiError.notFound('Physical file does not exist on disk'));
  }

  // Served under a type derived from the stored file name, not `doc.mimeType`:
  // rows written before uploads were content-checked carry whatever the client
  // claimed. nosniff and `attachment` stay, so a browser saves the bytes rather
  // than deciding for itself what they are.
  res.setHeader('Content-Type', mimeForFileName(doc.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition(doc.originalName));

  const fileStream = fs.createReadStream(doc.filePath);
  fileStream.pipe(res);
});

// @desc    List all documents for a vendor
// @route   GET /api/uploads
// @access  Public
const listDocuments = asyncHandler(async (req, res, next) => {
  const { linkedTo } = req.query;

  const where = vendorScope(req) ? { vendorId: vendorScope(req) } : {};
  if (linkedTo) {
    where.linkedTo = linkedTo;
  }

  const docs = await prisma.document.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json(docs);
});

// @desc    Delete a document
// @route   DELETE /api/uploads/:id
// @access  Public
const deleteDocument = asyncHandler(async (req, res, next) => {
  // A supplier reaches only their own documents, and someone else's is
  // indistinguishable from one that does not exist. Tenant staff reach any
  // document in their tenant — the tenant extension has already scoped the read.
  const doc = await prisma.document.findFirst({ where: scopedWhere(req, { pk: req.params.id }) });
  if (!doc) {
    return next(ApiError.notFound('Document not found'));
  }

  // The row goes first: if that fails the file is still there for the record
  // that points at it. The reverse order lost the file and kept the row.
  await prisma.document.delete({ where: { pk: doc.pk } });
  fs.rmSync(doc.filePath, { force: true });

  res.json({ message: 'Document deleted successfully' });
});

module.exports = {
  uploadFile,
  downloadFile,
  listDocuments,
  deleteDocument
};
