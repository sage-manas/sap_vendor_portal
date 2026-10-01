const request = require('supertest');
const buildTestApp = require('./testApp');
const { rawPrisma } = require('../db/prisma');
const { asTenant, registerVendor } = require('./helpers');
const { drainBackground } = require('../utils/background');

const app = buildTestApp();

const validRegistration = {
  vendorId: 'vendor_test_001',
  password: 'Secret12345',
  companyName: 'Acme Industries Pvt Ltd',
  gstin: '27AABCB1234F1Z5',
  pan: 'AABCB1234F',
  email: 'acme@example.com',
  phone: '9876543210',
  address: '12 MG Road',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  bankName: 'HDFC Bank',
  accountNumber: '123456789012',
  ifscCode: 'HDFC0000060',
  accountName: 'Acme Industries Pvt Ltd',
  bankBranch: 'Pune Main'
};

describe('POST /api/auth/register', () => {
  it('accepts a registration without issuing a session, and stores the password hashed', async () => {
    const res = await request(app).post('/api/auth/register').send(validRegistration);

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.body.vendor).toBeUndefined();

    // The account is created after the answer goes out.
    await drainBackground();
    const stored = await asTenant(() => rawPrisma.vendor.findFirst({
      where: { vendorId: validRegistration.vendorId },
      omit: { password: false },
    }));
    expect(stored.status).toBe('Draft');
    expect(stored.role).toBe('vendor');
    expect(stored.ifscCode).toBe('HDFC0000060');
    expect(stored.password).not.toBe(validRegistration.password);
  });

  it('answers a duplicate vendorId/email/gstin exactly as it answers a new one, and creates nothing', async () => {
    const first = await request(app).post('/api/auth/register').send(validRegistration);
    await drainBackground();
    const second = await request(app).post('/api/auth/register').send(validRegistration);
    await drainBackground();

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(await asTenant(() => rawPrisma.vendor.count({ where: { email: validRegistration.email } }))).toBe(1);
  });

  it('rejects invalid GSTIN, PAN, email, and short password with 400 field errors', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validRegistration,
      gstin: 'INVALID',
      pan: 'BAD',
      email: 'not-an-email',
      password: '123'
    });

    expect(res.status).toBe(400);
    expect(res.body.errors).toMatchObject({
      gstin: expect.any(String),
      pan: expect.any(String),
      email: expect.any(String),
      password: expect.any(String)
    });
  });

  // Issue #167: a supplier account holds bank details, GSTIN, PAN and KYC
  // documents behind a password alone (no MFA, unlike the platform console).
  // 6 characters with no complexity requirement was judged too weak to ship —
  // raised to 10 characters plus at least one lowercase, uppercase and digit.
  it.each([
    ['short but otherwise valid', 'Sh0rt12'],
    ['long enough but all lowercase', 'alllowercase123'],
    ['long enough but all uppercase', 'ALLUPPERCASE123'],
    ['long enough but no digit', 'NoDigitsHere'],
  ])('rejects a password that is %s', async (_label, password) => {
    const res = await request(app).post('/api/auth/register').send({
      ...validRegistration,
      vendorId: 'vendor_weak_pw',
      email: 'weak-pw@example.com',
      password,
    });

    expect(res.status).toBe(400);
    expect(res.body.errors.password).toEqual(expect.any(String));
  });

  it('accepts a password meeting the length and complexity floor', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validRegistration,
      vendorId: 'vendor_strong_pw',
      email: 'strong-pw@example.com',
      password: 'Str0ngEnough',
    });

    expect(res.status).toBe(202);
  });
});

describe('POST /api/auth/register — vendorId assignment', () => {
  const stored = (email) => asTenant(() => rawPrisma.vendor.findFirst({ where: { email } }));

  it('assigns a server-generated vendorId and Draft status when none is supplied', async () => {
    const { vendorId, ...withoutVendorId } = validRegistration;
    const res = await request(app).post('/api/auth/register').send(withoutVendorId);
    expect(res.status).toBe(202);

    await drainBackground();
    const vendor = await stored(validRegistration.email);
    expect(vendor.vendorId).toEqual(expect.stringMatching(/^VND-\d{5}$/));
    expect(vendor.status).toBe('Draft');
  });

  it('assigns distinct auto-generated vendorIds to successive registrations', async () => {
    const { vendorId, ...withoutVendorId } = validRegistration;
    await request(app).post('/api/auth/register').send(withoutVendorId);
    const second = await request(app).post('/api/auth/register').send({
      ...withoutVendorId,
      email: 'second-vendor@example.com',
      gstin: '29AABCS1234F1Z8'
    });
    expect(second.status).toBe(202);

    await drainBackground();
    const first = await stored(validRegistration.email);
    const other = await stored('second-vendor@example.com');
    expect(other.vendorId).not.toBe(first.vendorId);
    expect(other.vendorId).toEqual(expect.stringMatching(/^VND-\d{5}$/));
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await registerVendor(app);
  });

  it('logs in by vendorId', async () => {
    const res = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: validRegistration.vendorId,
      password: validRegistration.password
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.vendor.email).toBe(validRegistration.email);
  });

  it('logs in by email (case-insensitive)', async () => {
    const res = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: 'ACME@example.com',
      password: validRegistration.password
    });

    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: validRegistration.vendorId,
      password: 'wrong-password'
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects an unknown vendor with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: 'nobody@example.com',
      password: 'whatever'
    });

    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the profile for a valid token', async () => {
    const reg = await registerVendor(app);
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.token}`);

    expect(res.status).toBe(200);
    expect(res.body.vendor.vendorId).toBe(validRegistration.vendorId);
  });

  it('rejects a missing token with 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage token with 401', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
  });
});
