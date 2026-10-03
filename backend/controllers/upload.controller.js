const { prisma } = require('../db/prisma');
const fs = require('fs');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { assertCanCreate } = require('../utils/usage');
const { checkUpload, mimeForFileName, contentDisposition } = require('../utils/fileType');
const { refusalFor } = require('../services/virusScan.service');
const { activeStorage, storageFor, ttlSeconds } = require('../storage');
const { verify } = require('../storage/signing');
const { getTenantId, runWithTenant } = require('../utils/tenantContext');

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

// Served under a type derived from the stored file name, not `doc.mimeType`:
// rows written before uploads were content-checked carry whatever the client
// claimed. nosniff and `attachment` stay, so a browser saves the bytes rather
// than deciding for itself what they are.
const sendFile = async (res, doc) => {
  const stream = await storageFor(doc.storageDriver).open(doc);
  res.setHeader('Content-Type', mimeForFileName(doc.fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition(doc.originalName));
  stream.pipe(res);
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

  // Optional ClamAV scan (CLAMAV_HOST); a no-op when not configured. Runs on
  // the staged file, before anything is sent to the object store.
  const refusal = await refusalFor(file.path);
  if (refusal) {
    discard(file);
    return next(new ApiError(refusal.status, refusal.message));
  }

  const { linkedTo } = req.body;
  const storage = activeStorage();

  // Hand the validated file to the store. For the local driver it is already in
  // place; for object storage this is the upload, after which the staged copy
  // is removed whatever happens next.
  let stored;
  try {
    stored = await storage.put({
      filePath: file.path,
      key: storage.newKey?.({ clientId: getTenantId(), vendorId }),
      contentType: verdict.mime,
      size: file.size,
    });
  } catch (error) {
    discard(file);
    throw error;
  }

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
        storageDriver: storage.name,
        storageKey: stored.storageKey,
        filePath: stored.keepStaged ? file.path : '',
        linkedTo: linkedTo || 'Profile'
      },
    });
  } catch (error) {
    // The object is in the store and nothing points at it: take it back out.
    await storage.remove({ storageKey: stored.storageKey, filePath: file.path });
    discard(file);
    throw error;
  }

  if (!stored.keepStaged) discard(file);

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
  // document in their tenant — the tenant extension has already scoped the read.
  const doc = await prisma.document.findFirst({ where: scopedWhere(req, { pk: id }) });
  if (!doc) {
    return next(ApiError.notFound('Document not found'));
  }

  await sendFile(res, doc);
});

// @desc    A short-lived link that downloads the file without the session token
// @route   GET /api/uploads/:id/link
// @access  document:read
//
// The same visibility rule as the download above decides who gets one. The link
// is then the credential: object storage serves the bytes directly, so the API
// never carries them, and it stops working after SIGNED_URL_TTL_SECONDS.
const documentLink = asyncHandler(async (req, res, next) => {
  const doc = await prisma.document.findFirst({ where: scopedWhere(req, { pk: req.params.id }) });
  if (!doc) {
    return next(ApiError.notFound('Document not found'));
  }

  const link = await storageFor(doc.storageDriver).link(doc, { ttlSeconds: ttlSeconds(), clientId: getTenantId() });
  res.setHeader('Cache-Control', 'no-store');
  res.json(link);
});

// @desc    Serve a file for a link the local driver signed
// @route   GET /api/uploads/signed/:id?c=&exp=&sig=
// @access  by signature only (object storage does this itself)
const downloadSigned = asyncHandler(async (req, res, next) => {
  const { c: clientId, exp, sig } = req.query;
  if (!verify({ clientId, documentId: req.params.id, exp, sig })) {
    return next(ApiError.forbidden('This link is invalid or has expired'));
  }

  // The tenant is the one the signature covers, not one the caller names freely.
  await runWithTenant(clientId, async () => {
    const doc = await prisma.document.findFirst({ where: { pk: req.params.id } });
    if (!doc || doc.storageDriver !== 'local') return next(ApiError.notFound('Document not found'));
    res.setHeader('Cache-Control', 'no-store');
    return sendFile(res, doc);
  });
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
  await storageFor(doc.storageDriver).remove(doc);

  res.json({ message: 'Document deleted successfully' });
});

module.exports = {
  uploadFile,
  downloadFile,
  documentLink,
  downloadSigned,
  listDocuments,
  deleteDocument
};
