const Document = require('../models/Document');
const path = require('path');
const fs = require('fs');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const { requireVendorScope, vendorScope, isSupplier } = require('../utils/requestScope');

// @desc    Upload file and save document details
// @route   POST /api/uploads
// @access  Public
const uploadFile = asyncHandler(async (req, res, next) => {
  const vendorId = requireVendorScope(req);
  
  if (!req.file) {
    return next(ApiError.badRequest('No file uploaded'));
  }

  // Double check image sizes (max 5MB for images)
  const isImage = req.file.mimetype.startsWith('image/');
  if (isImage && req.file.size > 5 * 1024 * 1024) {
    // Clean up local file first
    fs.unlinkSync(req.file.path);
    return next(ApiError.badRequest('Image file size exceeds 5MB limit'));
  }

  const { linkedTo } = req.body;

  const doc = await Document.create({
    vendorId,
    fileName: req.file.filename,
    originalName: req.file.originalname,
    mimeType: req.file.mimetype,
    size: req.file.size,
    filePath: req.file.path,
    linkedTo: linkedTo || 'Profile'
  });

  res.status(201).json({
    documentId: doc._id,
    originalName: doc.originalName,
    fileName: doc.fileName,
    size: doc.size,
    url: `/api/uploads/${doc._id}`
  });
});

// @desc    Download / view uploaded file
// @route   GET /api/uploads/:id
// @access  Public
const downloadFile = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const vendorId = vendorScope(req);

  const doc = await Document.findById(id);
  if (!doc) {
    return next(ApiError.notFound('Document not found'));
  }

  // A supplier reaches only their own documents. Tenant staff reach any
  // document in their tenant — the tenant plugin has already scoped the read.
  if (isSupplier(req) && doc.vendorId !== vendorId) {
    return next(ApiError.forbidden('You do not have permission to view this document'));
  }

  if (!fs.existsSync(doc.filePath)) {
    return next(ApiError.notFound('Physical file does not exist on disk'));
  }

  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName}"`);
  
  const fileStream = fs.createReadStream(doc.filePath);
  fileStream.pipe(res);
});

// @desc    List all documents for a vendor
// @route   GET /api/uploads
// @access  Public
const listDocuments = asyncHandler(async (req, res, next) => {
  const { linkedTo } = req.query;

  const query = vendorScope(req) ? { vendorId: vendorScope(req) } : {};
  if (linkedTo) {
    query.linkedTo = linkedTo;
  }

  const docs = await Document.find(query).sort({ createdAt: -1 });
  res.json(docs);
});

// @desc    Delete a document
// @route   DELETE /api/uploads/:id
// @access  Public
const deleteDocument = asyncHandler(async (req, res, next) => {
  const { id } = req.params;
  const vendorId = vendorScope(req);

  const doc = await Document.findById(id);
  if (!doc) {
    return next(ApiError.notFound('Document not found'));
  }

  // A supplier reaches only their own documents. Tenant staff reach any
  // document in their tenant — the tenant plugin has already scoped the read.
  if (isSupplier(req) && doc.vendorId !== vendorId) {
    return next(ApiError.forbidden('You do not have permission to delete this document'));
  }

  // Remove from file system
  if (fs.existsSync(doc.filePath)) {
    fs.unlinkSync(doc.filePath);
  }

  await Document.findByIdAndDelete(id);
  res.json({ message: 'Document deleted successfully' });
});

module.exports = {
  uploadFile,
  downloadFile,
  listDocuments,
  deleteDocument
};
