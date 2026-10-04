const fs = require('fs');
const path = require('path');
const ApiError = require('../utils/ApiError');
const { sign } = require('./signing');

// Files on this server's own disk: the development default, and the home of any
// row not yet moved to object storage (scripts/migrate-uploads-to-object-storage.js).
// Multer writes the upload straight into its final folder, so `put` has nothing
// to move.

const BASE = path.join(__dirname, '..', 'uploads');

const safe = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');

const local = {
  name: 'local',

  // Where multer should write.
  stagingDir: (vendorId) => {
    const dir = path.join(BASE, safe(vendorId || 'shared'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },

  // The file is already where it will stay.
  put: async ({ filePath }) => ({ storageKey: path.relative(BASE, filePath).split(path.sep).join('/'), keepStaged: true }),

  open: async (doc) => {
    if (!doc.filePath || !fs.existsSync(doc.filePath)) throw ApiError.notFound('Physical file does not exist on disk');
    return fs.createReadStream(doc.filePath);
  },

  remove: async (doc) => {
    if (doc.filePath) fs.rmSync(doc.filePath, { force: true });
  },

  link: async (doc, { ttlSeconds, clientId }) => {
    const exp = String(Math.floor(Date.now() / 1000) + ttlSeconds);
    const sig = sign({ clientId, documentId: doc.pk, exp });
    return {
      url: `/api/uploads/signed/${doc.pk}?${new URLSearchParams({ c: clientId, exp, sig })}`,
      expiresAt: new Date(Number(exp) * 1000).toISOString(),
    };
  },
};

module.exports = local;
