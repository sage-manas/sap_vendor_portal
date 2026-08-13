const request = require('supertest');
const buildTestApp = require('./testApp');
const Vendor = require('../models/Vendor');
const { asTenant } = require('./helpers');

const app = buildTestApp();

const validRegistration = {
  vendorId: 'vendor_test_001',
  password: 'secret123',
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
  it('registers a vendor, returns a token, and hides the password', async () => {
    const res = await request(app).post('/api/auth/register').send(validRegistration);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.vendor.vendorId).toBe(validRegistration.vendorId);
    expect(res.body.vendor.status).toBe('Draft');
    expect(res.body.vendor.bankDetails.ifscCode).toBe('HDFC0000060');
    expect(res.body.vendor.password).toBeUndefined();

    // Password must be stored hashed
    const stored = await asTenant(() => Vendor.findOne({ vendorId: validRegistration.vendorId }).select('+password'));
    expect(stored.password).not.toBe(validRegistration.password);
  });

  it('rejects duplicate vendorId/email/gstin with 409', async () => {
    await request(app).post('/api/auth/register').send(validRegistration);
    const res = await request(app).post('/api/auth/register').send(validRegistration);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
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
});

describe('POST /api/auth/register — vendorId assignment', () => {
  it('assigns a server-generated vendorId and Draft status when none is supplied', async () => {
    const { vendorId, ...withoutVendorId } = validRegistration;
    const res = await request(app).post('/api/auth/register').send(withoutVendorId);

    expect(res.status).toBe(201);
    expect(res.body.vendor.vendorId).toEqual(expect.stringMatching(/^VND-\d{5}$/));
    expect(res.body.vendor.status).toBe('Draft');
  });

  it('assigns distinct auto-generated vendorIds to successive registrations', async () => {
    const { vendorId, ...withoutVendorId } = validRegistration;
    const first = await request(app).post('/api/auth/register').send(withoutVendorId);
    const second = await request(app).post('/api/auth/register').send({
      ...withoutVendorId,
      email: 'second-vendor@example.com',
      gstin: '29AABCS1234F1Z8'
    });

    expect(second.status).toBe(201);
    expect(second.body.vendor.vendorId).not.toBe(first.body.vendor.vendorId);
    expect(second.body.vendor.vendorId).toEqual(expect.stringMatching(/^VND-\d{5}$/));
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/register').send(validRegistration);
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
    const reg = await request(app).post('/api/auth/register').send(validRegistration);
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.body.token}`);

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
