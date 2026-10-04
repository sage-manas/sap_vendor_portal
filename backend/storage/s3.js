const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { contentDisposition, mimeForFileName } = require('../utils/fileType');
const { readConfig } = require('./config');

// S3-compatible object storage: AWS S3, Cloudflare R2, Backblaze B2, Wasabi,
// MinIO. Configured entirely from the environment (storage/config.js); the SDK
// is only loaded when this driver is actually used.
//
//   * The bucket is private. Nothing here sets an ACL, and files leave it only
//     as short-lived presigned URLs minted after the API has checked who is
//     asking (controllers/upload.controller.js).
//   * Objects are encrypted at rest by the provider (SSE-S3, or SSE-KMS with a
//     key the operator names). That is the standard answer for a store whose
//     files must be reachable by a plain URL; encrypting in the portal instead
//     would force every download back through this server.
//   * Keys are <clientId>/<vendorId>/<random uuid>: no file name, no supplier
//     name, nothing guessable from a bucket listing. The display name lives in
//     the database and is applied through Content-Disposition on download.

const clients = new Map();

// Loaded on first use. The checksum options keep to what S3-compatible stores
// accept: the SDK newer default adds CRC32 trailers that several of them (R2,
// B2, older MinIO) reject on a streamed PUT.
const clientFor = (config) => {
  const cacheKey = JSON.stringify(config);
  if (clients.has(cacheKey)) return clients.get(cacheKey);

  const { S3Client } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint || undefined,
    forcePathStyle: config.forcePathStyle,
    credentials: config.accessKeyId ? { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } : undefined,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  clients.set(cacheKey, client);
  return client;
};

const encryption = (config) => {
  if (config.sse === 'none') return {};
  return {
    ServerSideEncryption: config.sse,
    ...(config.sse === 'aws:kms' && config.kmsKeyId ? { SSEKMSKeyId: config.kmsKeyId } : {}),
  };
};

const storageError = (action, error) => {
  // The provider message can name the bucket and key; the log gets it, the
  // caller gets a plain failure.
  logger.error(`[storage] ${action} failed: ${error.name || 'Error'}: ${error.message}`);
  return new ApiError(error.$metadata?.httpStatusCode === 404 ? 404 : 502, 'The document store could not complete the request');
};

const safe = (value) => String(value || 'shared').replace(/[^a-zA-Z0-9_-]/g, '_');

const s3 = {
  name: 's3',

  stagingDir: (vendorId) => {
    const dir = path.join(os.tmpdir(), 'vendorconnect-staging', safe(vendorId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },

  newKey: ({ clientId, vendorId }) => `${clientId}/${safe(vendorId)}/${crypto.randomUUID()}`,

  put: async ({ filePath, key, contentType, size }) => {
    const config = readConfig();
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await clientFor(config).send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentLength: size,
        ContentType: contentType,
        CacheControl: 'private, no-store',
        ...encryption(config),
      }));
    } catch (error) {
      throw storageError('put', error);
    }
    return { storageKey: key };
  },

  open: async (doc) => {
    const config = readConfig();
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    try {
      const { Body } = await clientFor(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: doc.storageKey }));
      return Body;
    } catch (error) {
      throw storageError('get', error);
    }
  },

  head: async (key) => {
    const config = readConfig();
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const { ContentLength } = await clientFor(config).send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return { size: ContentLength };
  },

  remove: async (doc) => {
    if (!doc.storageKey) return;
    const config = readConfig();
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await clientFor(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: doc.storageKey }));
    } catch (error) {
      // The row is already gone; an object that could not be removed is an
      // orphan to sweep, not a reason to fail the caller delete.
      logger.error(`[storage] delete of ${doc.storageKey} failed: ${error.message}`);
    }
  },

  link: async (doc, { ttlSeconds }) => {
    const config = readConfig();
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    try {
      const url = await getSignedUrl(clientFor(config), new GetObjectCommand({
        Bucket: config.bucket,
        Key: doc.storageKey,
        // Fixed by us, never taken from what the client claimed about the file.
        ResponseContentDisposition: contentDisposition(doc.originalName),
        ResponseContentType: mimeForFileName(doc.fileName),
      }), { expiresIn: ttlSeconds });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    } catch (error) {
      throw storageError('presign', error);
    }
  },
};

module.exports = s3;
