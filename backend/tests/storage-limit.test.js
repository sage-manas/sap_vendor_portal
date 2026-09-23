// Issue #116. limitStorageMb was settable, validated and shown in the
// platform console, but nothing ever counted, enforced or displayed usage
// against it. These tests drive the real upload endpoint — not a Document
// row seeded directly through Prisma — because the behaviour under test is
// exactly "what happens when a file is uploaded", and seeding around that
// would be the API-bypass AGENTS.md warns against.
//
// upload.js's UPLOAD_DIR config is dead — it hardcodes `backend/uploads/`,
// a committed directory — so every test here cleans up any file it leaves
// behind, either through the app's own DELETE endpoint (which also happens
// to be what proves a deletion frees the allowance) or directly, never
// leaving a stray file for a future `git status` to notice.

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const buildTestApp = require('./testApp');
const { rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, createAdminUser } = require('./helpers');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const setStorageLimit = (mb) => withoutTenantScope(() => rawPrisma.client.updateMany({
  where: { clientId: 'CLT-0001' },
  data: { limitStorageMb: mb },
}));

const uploadDir = path.join(__dirname, '..', 'uploads');

// A buffer of an exact byte size, so the MB math in a test is exact rather
// than depending on how large some fixture file happens to be.
const bufferOfBytes = (bytes) => Buffer.alloc(bytes, 'x');

const upload = (token, { bytes = 1024, filename = 'doc.pdf' } = {}) =>
  request(app)
    .post('/api/uploads')
    .set(bearer(token))
    .attach('file', bufferOfBytes(bytes), filename);

const deleteDoc = (token, documentId) =>
  request(app).delete(`/api/uploads/${documentId}`).set(bearer(token));

describe('storage plan limit', () => {
  it('usageAgainstLimits reports storage used against the plan, in MB', async () => {
    const { token: vendorToken, vendor } = await registerVendor(app, { vendorId: 'storage_1', gstin: '27AAAAA3001A1Z1' });
    const { token: adminToken } = await createAdminUser({ email: 'storage-admin-1@example.com' });
    await setStorageLimit(1024);

    const oneMb = 1024 * 1024;
    const res = await upload(vendorToken, { bytes: oneMb });
    expect(res.status).toBe(201);

    const overview = await request(app).get('/api/workspace/overview').set(bearer(adminToken));
    expect(overview.body.usage.storageMb.used).toBeCloseTo(1, 1);
    expect(overview.body.usage.storageMb.limit).toBe(1024);
    expect(overview.body.usage.storageMb.breached).toBe(false);

    // Clean-up via the real endpoint, which is also #116's own acceptance
    // criterion: a deletion must free the allowance again.
    await deleteDoc(adminToken, res.body.documentId);
    const after = await request(app).get('/api/workspace/overview').set(bearer(adminToken));
    expect(after.body.usage.storageMb.used).toBe(0);
  });

  it('refuses an upload that would push the tenant over its storage limit', async () => {
    const { token: vendorToken, vendor } = await registerVendor(app, { vendorId: 'storage_2', gstin: '27AAAAA3002A1Z1' });
    // A limit smaller than the file about to be sent — 0.5MB cap, 1MB file.
    await setStorageLimit(0.5);

    const res = await upload(vendorToken, { bytes: 1024 * 1024, filename: 'toobig.pdf' });

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('plan_limit_reached');

    // Nothing left behind: no Document row, and — the point of unlinking on
    // refusal — no file on disk either, checked directly rather than only
    // through the API.
    const list = await request(app).get('/api/uploads').set(bearer(vendorToken));
    expect(list.body).toEqual([]);

    const vendorDir = path.join(uploadDir, vendor.vendorId);
    if (fs.existsSync(vendorDir)) {
      expect(fs.readdirSync(vendorDir)).toEqual([]);
    }
  });

  it('allows an upload that fits within the limit', async () => {
    const { token: vendorToken } = await registerVendor(app, { vendorId: 'storage_3', gstin: '27AAAAA3003A1Z1' });
    const { token: adminToken } = await createAdminUser({ email: 'storage-admin-3@example.com' });
    await setStorageLimit(10);

    const res = await upload(vendorToken, { bytes: 1024 });
    expect(res.status).toBe(201);

    await deleteDoc(adminToken, res.body.documentId);
  });

  it('frees the allowance when a document is deleted, letting the next upload through', async () => {
    const { token: vendorToken } = await registerVendor(app, { vendorId: 'storage_4', gstin: '27AAAAA3004A1Z1' });
    const { token: adminToken } = await createAdminUser({ email: 'storage-admin-4@example.com' });
    // Room for exactly one 1MB file at a time.
    await setStorageLimit(1);

    const first = await upload(vendorToken, { bytes: 1024 * 1024, filename: 'first.pdf' });
    expect(first.status).toBe(201);

    const second = await upload(vendorToken, { bytes: 1024 * 1024, filename: 'second.pdf' });
    expect(second.status).toBe(402);

    await deleteDoc(adminToken, first.body.documentId);

    const retry = await upload(vendorToken, { bytes: 1024 * 1024, filename: 'second-retry.pdf' });
    expect(retry.status).toBe(201);

    await deleteDoc(adminToken, retry.body.documentId);
  });

  it('treats an unset limit as unlimited', async () => {
    const { token: vendorToken } = await registerVendor(app, { vendorId: 'storage_5', gstin: '27AAAAA3005A1Z1' });
    const { token: adminToken } = await createAdminUser({ email: 'storage-admin-5@example.com' });
    await setStorageLimit(null);

    const res = await upload(vendorToken, { bytes: 2 * 1024 * 1024 });
    expect(res.status).toBe(201);

    await deleteDoc(adminToken, res.body.documentId);
  });

  it('enforces a limit of exactly 0 rather than reading it as unlimited', async () => {
    const { token: vendorToken } = await registerVendor(app, { vendorId: 'storage_6', gstin: '27AAAAA3006A1Z1' });
    await setStorageLimit(0);

    const res = await upload(vendorToken, { bytes: 1024 });

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('plan_limit_reached');
  });
});
