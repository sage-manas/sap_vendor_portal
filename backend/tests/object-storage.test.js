const request = require('supertest');
const fs = require('fs');
const path = require('path');
const buildTestApp = require('./testApp');
const fakeS3 = require('./fakeS3');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createAdminUser } = require('./helpers');

// 2.3 — uploads (cancelled cheques, PAN cards, GST certificates: identity and
// bank documents) lived on the API server's disk, served by streaming from a
// path. They now go to S3-compatible object storage, encrypted at rest, and are
// handed out as short-lived signed links. The local disk driver remains for
// development and for rows not yet migrated.

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('cancelled cheque for the test, not a real one')]);

const upload = (token, { buffer = PDF, filename = 'cancelled-cheque.pdf' } = {}) =>
  request(app).post('/api/uploads').set(bearer(token)).attach('file', buffer, filename);

const ENV_KEYS = [
  'STORAGE_DRIVER', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE', 'STORAGE_SSE', 'STORAGE_KMS_KEY_ID', 'SIGNED_URL_TTL_SECONDS',
];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const restoreEnv = () => ENV_KEYS.forEach((key) => { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });

const stagingFiles = () => {
  const roots = [path.join(__dirname, '..', 'uploads'), path.join(require('os').tmpdir(), 'vendorconnect-staging')];
  return roots.flatMap((dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).filter((name) => fs.statSync(path.join(dir, name)).isFile()).map((name) => path.join(dir, name))
    : []));
};

// The local-driver tests leave real files under backend/uploads/<vendor>; remove
// them rather than leave them for a later `git status` (the directory is ignored,
// but it is the developer's own).
afterAll(() => {
  ['storage_local', 'storage_move', 'storage_dry'].forEach((vendor) => fs.rmSync(path.join(__dirname, '..', 'uploads', vendor), { recursive: true, force: true }));
});

describe('with S3-compatible storage configured', () => {
  let s3;
  let vendorToken;
  let otherVendorToken;

  beforeAll(async () => {
    s3 = await fakeS3.start();
  });
  afterAll(async () => {
    restoreEnv();
    await s3.stop();
  });

  beforeEach(async () => {
    Object.assign(process.env, {
      STORAGE_DRIVER: 's3',
      S3_ENDPOINT: s3.endpoint,
      S3_BUCKET: s3.bucket,
      S3_REGION: 'ap-south-1',
      S3_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST',
      S3_SECRET_ACCESS_KEY: 'test-secret-access-key-0123456789',
      S3_FORCE_PATH_STYLE: 'true',
    });
    delete process.env.STORAGE_SSE;
    delete process.env.SIGNED_URL_TTL_SECONDS;
    s3.objects.clear();
    s3.requests.length = 0;

    ({ token: vendorToken } = await registerVendor(app, { vendorId: 'storage_a', gstin: '27AAAAA4001A1Z1', email: 'a@example.com' }));
    ({ token: otherVendorToken } = await registerVendor(app, { vendorId: 'storage_b', gstin: '27AAAAA4002A1Z2', email: 'b@example.com' }));
  });

  describe('storing a file', () => {
    it('puts the bytes in the bucket under a key that names no person or file, and serves them back', async () => {
      const res = await upload(vendorToken);
      expect(res.status).toBe(201);

      expect(s3.objects.size).toBe(1);
      const [[key, object]] = [...s3.objects.entries()];
      expect(object.body.equals(PDF)).toBe(true);
      expect(key.startsWith('CLT-0001/storage_a/')).toBe(true);
      expect(key).not.toMatch(/cheque/i);

      const doc = await withoutTenantScope(() => rawPrisma.document.findUnique({ where: { pk: res.body.documentId } }));
      expect(doc).toMatchObject({ storageDriver: 's3', storageKey: key });
    });

    it('asks the provider to encrypt it at rest (SSE-S3 unless told otherwise)', async () => {
      await upload(vendorToken);
      const put = s3.requests.find((request_) => request_.method === 'PUT');
      expect(put.headers['x-amz-server-side-encryption']).toBe('AES256');
    });

    it('can be told to use a KMS key instead', async () => {
      process.env.STORAGE_SSE = 'aws:kms';
      process.env.STORAGE_KMS_KEY_ID = 'arn:aws:kms:ap-south-1:111122223333:key/abc';
      await upload(vendorToken);
      const put = s3.requests.find((request_) => request_.method === 'PUT');
      expect(put.headers['x-amz-server-side-encryption']).toBe('aws:kms');
      expect(put.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe('arn:aws:kms:ap-south-1:111122223333:key/abc');
    });

    it('marks the object private and uncacheable', async () => {
      await upload(vendorToken);
      const put = s3.requests.find((request_) => request_.method === 'PUT');
      expect(put.headers['cache-control']).toMatch(/private/);
      expect(put.headers['x-amz-acl']).toBeUndefined();
    });

    it('leaves nothing on the API server\'s disk', async () => {
      const before = stagingFiles().length;
      await upload(vendorToken);
      expect(stagingFiles().length).toBe(before);
    });

    it('records no Document, and leaves no staged file, when the provider refuses the write', async () => {
      const before = stagingFiles().length;
      s3.failNextPut();

      const res = await upload(vendorToken);

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await withoutTenantScope(() => rawPrisma.document.count({ where: { vendorId: 'storage_a' } }))).toBe(0);
      expect(stagingFiles().length).toBe(before);
    });

    it('still refuses a file whose contents are not what its name says, before any write', async () => {
      const res = await upload(vendorToken, { buffer: Buffer.from('MZ not a pdf at all'), filename: 'x.pdf' });
      expect(res.status).toBe(400);
      expect(s3.objects.size).toBe(0);
    });
  });

  describe('reading a file back', () => {
    it('streams it through the API with the same headers as before', async () => {
      const { body: { documentId } } = await upload(vendorToken);

      const res = await request(app).get(`/api/uploads/${documentId}`).set(bearer(vendorToken)).buffer(true).parse((r, cb) => {
        const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

      expect(res.status).toBe(200);
      expect(res.body.equals(PDF)).toBe(true);
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="cancelled-cheque.pdf"/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('does not let another supplier read it', async () => {
      const { body: { documentId } } = await upload(vendorToken);
      const res = await request(app).get(`/api/uploads/${documentId}`).set(bearer(otherVendorToken));
      expect(res.status).toBe(404);
    });
  });

  describe('signed links', () => {
    const linkFor = (token, documentId) => request(app).get(`/api/uploads/${documentId}/link`).set(bearer(token));

    it('hands the owner a short-lived presigned URL that downloads the file as an attachment', async () => {
      const { body: { documentId } } = await upload(vendorToken);

      const res = await linkFor(vendorToken, documentId);

      expect(res.status).toBe(200);
      const url = new URL(res.body.url);
      expect(url.origin).toBe(s3.endpoint);
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(res.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 300 * 1000);

      const download = await fetch(res.body.url);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).equals(PDF)).toBe(true);
      expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="cancelled-cheque.pdf"/);
      expect(download.headers.get('content-type')).toBe('application/pdf');
    });

    it('lifetime is configurable', async () => {
      process.env.SIGNED_URL_TTL_SECONDS = '30';
      const { body: { documentId } } = await upload(vendorToken);
      const res = await linkFor(vendorToken, documentId);
      expect(new URL(res.body.url).searchParams.get('X-Amz-Expires')).toBe('30');
    });

    it('is not given for another supplier\'s document, and not to someone signed out', async () => {
      const { body: { documentId } } = await upload(vendorToken);

      expect((await linkFor(otherVendorToken, documentId)).status).toBe(404);
      expect((await request(app).get(`/api/uploads/${documentId}/link`)).status).toBe(401);
    });

    it('is given to tenant staff for any document in their tenant', async () => {
      const { body: { documentId } } = await upload(vendorToken);
      const { token: staff } = await createAdminUser({ email: 'storage-admin@example.com' });

      const res = await linkFor(staff, documentId);
      expect(res.status).toBe(200);
      expect(new URL(res.body.url).origin).toBe(s3.endpoint);
    });

    it('does not put the bucket credentials in the URL', async () => {
      const { body: { documentId } } = await upload(vendorToken);
      const res = await linkFor(vendorToken, documentId);
      expect(res.body.url).not.toContain('test-secret-access-key');
    });
  });

  describe('deleting', () => {
    it('removes the object as well as the row', async () => {
      const { body: { documentId } } = await upload(vendorToken);
      expect(s3.objects.size).toBe(1);

      const { token: staff } = await createAdminUser({ email: 'storage-delete-admin@example.com' });

      const res = await request(app).delete(`/api/uploads/${documentId}`).set(bearer(staff));

      expect(res.status).toBe(200);
      expect(s3.objects.size).toBe(0);
    });
  });
});

describe('with the local disk driver (development)', () => {
  let vendorToken;

  beforeEach(async () => {
    restoreEnv();
    delete process.env.STORAGE_DRIVER;
    ({ token: vendorToken } = await registerVendor(app, { vendorId: 'storage_local', gstin: '27AAAAA4003A1Z3', email: 'local@example.com' }));
  });

  it('issues a signed link served by the API, valid for the file it names and nothing else', async () => {
    const { body: { documentId } } = await upload(vendorToken);

    const link = await request(app).get(`/api/uploads/${documentId}/link`).set(bearer(vendorToken));
    expect(link.status).toBe(200);
    const url = new URL(link.body.url, 'http://localhost');
    expect(url.pathname).toBe(`/api/uploads/signed/${documentId}`);

    const ok = await request(app).get(`${url.pathname}${url.search}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toMatch(/^attachment/);
    expect(ok.headers['content-type']).toBe('application/pdf');

    const tampered = new URLSearchParams(url.search);
    tampered.set('sig', `${tampered.get('sig').slice(0, -2)}00`);
    expect((await request(app).get(`${url.pathname}?${tampered}`)).status).toBe(403);

    const otherDoc = '00000000-0000-4000-8000-000000000000';
    expect((await request(app).get(`/api/uploads/signed/${otherDoc}${url.search}`)).status).toBe(403);
  });

  it('refuses an expired link', async () => {
    const { body: { documentId } } = await upload(vendorToken);
    process.env.SIGNED_URL_TTL_SECONDS = '1';
    const link = await request(app).get(`/api/uploads/${documentId}/link`).set(bearer(vendorToken));
    const url = new URL(link.body.url, 'http://localhost');

    await new Promise((resolve) => setTimeout(resolve, 2100));

    expect((await request(app).get(`${url.pathname}${url.search}`)).status).toBe(403);
    delete process.env.SIGNED_URL_TTL_SECONDS;
  });

  it('refuses a signed link for a document in another tenant', async () => {
    const { body: { documentId } } = await upload(vendorToken);
    const link = await request(app).get(`/api/uploads/${documentId}/link`).set(bearer(vendorToken));
    const url = new URL(link.body.url, 'http://localhost');
    url.searchParams.set('c', 'CLT-9999');

    expect((await request(app).get(`${url.pathname}${url.search}`)).status).toBe(403);
  });
});

describe('boot configuration', () => {
  const validateEnv = require('../config/validateEnv');
  const base = {
    NODE_ENV: 'production', PORT: '5000', DATABASE_URL: 'x', FRONTEND_URL: 'https://a.example', PORTAL_BASE_DOMAIN: 'a.example',
    MASTER_KEY: 'k', JWT_SECRET: 'x'.repeat(40), INTERNAL_KEY: 'y'.repeat(40), CLAMAV_REQUIRED: '', ADMIN_BOOTSTRAP_EMAILS: '',
    STORAGE_DRIVER: 's3', S3_BUCKET: 'vc-uploads', S3_REGION: 'ap-south-1', STORAGE_ALLOW_LOCAL: '',
  };

  const boots = (overrides) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const previous = Object.fromEntries(Object.keys({ ...base, ...overrides }).map((key) => [key, process.env[key]]));
    Object.entries({ ...base, ...overrides }).forEach(([key, value]) => { process.env[key] = value; });
    try {
      validateEnv();
      return true;
    } catch (error) {
      if (error.message === 'exit') return false;
      throw error;
    } finally {
      exit.mockRestore();
      Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    }
  };

  it('boots in production with S3 storage configured', () => {
    expect(boots({})).toBe(true);
  });

  it('refuses to boot in production on the local disk unless that is accepted knowingly', () => {
    expect(boots({ STORAGE_DRIVER: '' })).toBe(false);
    expect(boots({ STORAGE_DRIVER: 'local' })).toBe(false);
    expect(boots({ STORAGE_DRIVER: 'local', STORAGE_ALLOW_LOCAL: 'true' })).toBe(true);
  });

  it('refuses to boot with S3 selected but no bucket', () => {
    expect(boots({ S3_BUCKET: '' })).toBe(false);
  });

  it('refuses an unknown driver, and an unknown encryption mode', () => {
    expect(boots({ STORAGE_DRIVER: 'ftp' })).toBe(false);
    expect(boots({ STORAGE_SSE: 'rot13' })).toBe(false);
  });

  it('requires a key id when KMS encryption is chosen', () => {
    expect(boots({ STORAGE_SSE: 'aws:kms', STORAGE_KMS_KEY_ID: '' })).toBe(false);
    expect(boots({ STORAGE_SSE: 'aws:kms', STORAGE_KMS_KEY_ID: 'alias/vc' })).toBe(true);
  });
});

describe('moving existing uploads to object storage', () => {
  let s3;

  beforeAll(async () => { s3 = await fakeS3.start(); });
  afterAll(async () => { restoreEnv(); await s3.stop(); });

  it('copies each local file to the bucket, repoints its row, keeps the file readable, and can be run again', async () => {
    restoreEnv();
    delete process.env.STORAGE_DRIVER;
    const { token } = await registerVendor(app, { vendorId: 'storage_move', gstin: '27AAAAA4004A1Z4', email: 'move@example.com' });
    const { body: { documentId } } = await upload(token);
    const missing = await upload(token, { filename: 'gone.pdf' });
    const gonePath = (await withoutTenantScope(() => rawPrisma.document.findUnique({ where: { pk: missing.body.documentId } }))).filePath;
    fs.rmSync(gonePath);

    Object.assign(process.env, {
      STORAGE_DRIVER: 's3', S3_ENDPOINT: s3.endpoint, S3_BUCKET: s3.bucket, S3_REGION: 'ap-south-1',
      S3_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST', S3_SECRET_ACCESS_KEY: 'test-secret-access-key-0123456789', S3_FORCE_PATH_STYLE: 'true',
    });
    const { migrateUploads } = require('../scripts/migrate-uploads-to-object-storage');

    const first = await migrateUploads();
    expect(first).toMatchObject({ moved: 1, missing: 1, failed: 0 });

    const doc = await withoutTenantScope(() => rawPrisma.document.findUnique({ where: { pk: documentId } }));
    expect(doc.storageDriver).toBe('s3');
    expect(s3.objects.get(doc.storageKey).body.equals(PDF)).toBe(true);

    const download = await request(app).get(`/api/uploads/${documentId}`).set(bearer(token)).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(download.status).toBe(200);
    expect(download.body.equals(PDF)).toBe(true);

    const second = await migrateUploads();
    expect(second).toMatchObject({ moved: 0, missing: 1, failed: 0 });

    // The local copy is left in place: removing it is a separate, deliberate step.
    expect(fs.existsSync(path.join(__dirname, '..', 'uploads', 'storage_move'))).toBe(true);
  });

  it('changes nothing in a dry run', async () => {
    restoreEnv();
    delete process.env.STORAGE_DRIVER;
    const { token } = await registerVendor(app, { vendorId: 'storage_dry', gstin: '27AAAAA4005A1Z5', email: 'dry@example.com' });
    const { body: { documentId } } = await upload(token);
    Object.assign(process.env, {
      STORAGE_DRIVER: 's3', S3_ENDPOINT: s3.endpoint, S3_BUCKET: s3.bucket, S3_REGION: 'ap-south-1',
      S3_ACCESS_KEY_ID: 'AKIATESTTESTTESTTEST', S3_SECRET_ACCESS_KEY: 'test-secret-access-key-0123456789', S3_FORCE_PATH_STYLE: 'true',
    });
    const before = s3.objects.size;
    const { migrateUploads } = require('../scripts/migrate-uploads-to-object-storage');

    const result = await migrateUploads({ dryRun: true });

    expect(result.moved).toBe(0);
    expect(result.wouldMove).toBeGreaterThanOrEqual(1);
    expect(s3.objects.size).toBe(before);
    expect((await withoutTenantScope(() => rawPrisma.document.findUnique({ where: { pk: documentId } }))).storageDriver).toBe('local');
  });
});
