// Issue #67: Vendor.gstin was globally @unique, so a real supplier trading
// with two buyers could only ever complete registration with the first one —
// the second attempt failed on vendors_gstin_key even though the two rows
// belong to entirely different tenants. See ADR-0039: gstin moves to
// @@unique([clientId, gstin]); vendorId/email stay global login identities
// (ADR-0002), unaffected here.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant, seedClient } = require('./helpers');

const app = buildTestApp();

const SHARED_GSTIN = '27AABCS9999F1Z5';

describe('Vendor.gstin is unique per tenant, not platform-wide (issue #67)', () => {
  it('lets the same GSTIN be onboarded by two different tenants', async () => {
    const first = await registerVendor(app, {
      vendorId: 'vendor_gstin_a', email: 'gstin-a@example.com', gstin: SHARED_GSTIN,
    }, { clientSlug: 'legacy' });

    const second = await registerVendor(app, {
      clientId: 'CLT-0002', vendorId: 'vendor_gstin_b', email: 'gstin-b@example.com', gstin: SHARED_GSTIN,
    }, { clientSlug: 'rival' });

    expect(first.vendor.gstin).toBe(SHARED_GSTIN);
    expect(second.vendor.gstin).toBe(SHARED_GSTIN);
    expect(first.vendor.clientId).not.toBe(second.vendor.clientId);
  });

  it('still refuses a second registration with the same GSTIN inside the same tenant', async () => {
    await registerVendor(app, {
      vendorId: 'vendor_gstin_c', email: 'gstin-c@example.com', gstin: SHARED_GSTIN,
    }, { clientSlug: 'legacy' });

    const res = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'legacy')
      .send({
        ...require('./helpers').baseVendor,
        vendorId: 'vendor_gstin_d', email: 'gstin-d@example.com', gstin: SHARED_GSTIN,
      });

    expect(res.status).toBe(409);
  });

  it('keeps email a global login identity — a second tenant cannot reuse it even with a fresh GSTIN', async () => {
    await registerVendor(app, {
      vendorId: 'vendor_gstin_e', email: 'gstin-shared-email@example.com', gstin: SHARED_GSTIN,
    }, { clientSlug: 'legacy' });
    await seedClient({ clientId: 'CLT-0002', slug: 'rival' });

    const res = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'rival')
      .send({
        ...require('./helpers').baseVendor,
        clientId: 'CLT-0002',
        vendorId: 'vendor_gstin_f', email: 'gstin-shared-email@example.com', gstin: '29AABCF0000F1Z1',
      });

    expect(res.status).toBe(409);
  });

  it('keeps each tenant blind to the other GSTIN-sharing vendor row (tenant isolation)', async () => {
    const first = await registerVendor(app, {
      vendorId: 'vendor_gstin_g', email: 'gstin-g@example.com', gstin: SHARED_GSTIN,
    }, { clientSlug: 'legacy' });

    const second = await registerVendor(app, {
      clientId: 'CLT-0002', vendorId: 'vendor_gstin_h', email: 'gstin-h@example.com', gstin: SHARED_GSTIN,
    }, { clientSlug: 'rival' });

    const seenFromA = await asTenant(() => prisma.vendor.findMany({ where: { gstin: SHARED_GSTIN } }), 'CLT-0001');
    const seenFromB = await asTenant(() => prisma.vendor.findMany({ where: { gstin: SHARED_GSTIN } }), 'CLT-0002');

    expect(seenFromA.map((v) => v.vendorId)).toEqual([first.vendor.vendorId]);
    expect(seenFromB.map((v) => v.vendorId)).toEqual([second.vendor.vendorId]);
  });
});
