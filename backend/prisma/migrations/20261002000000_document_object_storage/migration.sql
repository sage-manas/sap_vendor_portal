-- Uploads can live in S3-compatible object storage (backend/storage/). Existing
-- rows stay on the local disk until scripts/migrate-uploads-to-object-storage.js
-- moves them, so every new column has a default that describes them.
ALTER TABLE "documents" ADD COLUMN "storageDriver" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "documents" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "documents" ALTER COLUMN "filePath" SET DEFAULT '';
