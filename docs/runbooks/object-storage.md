# Object storage for uploaded documents

Supplier documents (cancelled cheques, PAN cards, GST and MSME certificates) are
identity and bank material. In production they live in an S3-compatible bucket,
encrypted at rest, and are handed to a browser only as short-lived signed links.
The API server's disk holds nothing but the few seconds a file is staged while it
is checked.

Code: `backend/storage/` (drivers), `backend/controllers/upload.controller.js`.

## Choose a provider

Anything that speaks the S3 API works with the same settings: AWS S3, Cloudflare
R2, Backblaze B2, Wasabi, a self-hosted MinIO. Decide on residency (an Indian
buyer's supplier data in `ap-south-1` Mumbai, or an Indian region of another
provider) and on who operates it. Nothing in the code depends on the choice.

## Create the bucket

1. **Private.** Turn on "block all public access" (S3) or the equivalent. The
   portal never sets an ACL and never serves a public URL.
2. **Encryption at rest.** Default encryption on the bucket as well as the
   per-request header the portal sends (`STORAGE_SSE`, below), so an object put
   by any other tool is encrypted too.
3. **Versioning on, with a lifecycle rule** expiring noncurrent versions after
   30 to 90 days. This replaces backing up an uploads directory: an
   accidental or malicious delete is recoverable for that long.
4. **No CORS rule is needed.** Downloads are plain navigations to the signed URL,
   not cross-origin `fetch`.
5. **Access logging** to a separate bucket, if the provider offers it.

## A user limited to that bucket

Create a dedicated access key. It needs three actions on `bucket/*` and nothing
else (no list, no bucket administration, no other buckets):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
  }]
}
```

(`HeadObject` is covered by `GetObject`.) If the server runs on AWS, prefer an
instance role over a key pair and leave `S3_ACCESS_KEY_ID` unset.

## Settings

In `backend/.env`:

```text
STORAGE_DRIVER=s3
S3_BUCKET=vendorconnect-uploads
S3_REGION=ap-south-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
# Providers other than AWS:
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true          # MinIO, and some others
# Encryption the portal asks for on every write:
STORAGE_SSE=AES256                # default; or aws:kms (+ STORAGE_KMS_KEY_ID), or none
# Signed link lifetime, seconds (default 120, at most 900):
SIGNED_URL_TTL_SECONDS=120
```

`STORAGE_SSE=none` is for a provider that encrypts everything itself and rejects
the header (some MinIO set-ups); say so deliberately. The server refuses to start
in production on the local disk unless `STORAGE_ALLOW_LOCAL=true`, and refuses a
bucket-less or misspelt configuration.

Secrets in the S3 settings are not written to logs.

## Moving the files already on the server

Do this once, on the server that holds `backend/uploads/`, after a test upload
has worked end to end:

```bash
cd backend
npm run prisma:deploy                                        # adds the storageDriver/storageKey columns
node scripts/migrate-uploads-to-object-storage.js --dry-run  # counts, changes nothing
node scripts/migrate-uploads-to-object-storage.js            # copies, verifies size, repoints rows
```

It is safe to repeat or interrupt. A row is repointed only after the object is in
the bucket and its size matches; a row whose file is missing from disk is
reported (`missing`) and left alone; and the local files are kept. Download a
handful of real documents through the portal to confirm, then remove
`backend/uploads/` (after taking, or keeping, the last pre-migration backup).
`--delete-local` does the removal as it goes, for operators who prefer it, and
only for rows moved in that run.

Until a row is moved it keeps being served from disk, so the migration can happen
at any time after deploying.

## Checking it works

1. Upload a document as a supplier. It appears in the bucket under
   `CLT-xxxx/<vendorId>/<uuid>`, with no file name in the key, and shows the
   encryption you configured in the provider console.
2. Open it as tenant staff: the portal fetches `GET /api/uploads/<id>/link` and
   opens the returned URL. The URL stops working after `SIGNED_URL_TTL_SECONDS`.
3. The signed URL is the credential. Do not log it, paste it into tickets or
   keep it in a document.

## Rotating the access key

Create the new key, put it in `backend/.env`, restart `vendorconnect-api` and
`vendorconnect-jobs`, confirm an upload and a download, then delete the old key.
In-flight signed links were signed with the old key and stop working when it is
deleted (they last at most `SIGNED_URL_TTL_SECONDS` anyway).
