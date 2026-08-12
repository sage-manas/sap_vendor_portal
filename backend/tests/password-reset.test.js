const request = require('supertest');
const buildTestApp = require('./testApp');
const Vendor = require('../models/Vendor');
const logger = require('../utils/logger');
const { baseVendor, registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();

// forgotPassword logs the reset URL (no email service is configured) — pull
// the raw token back out of that log line since it's the only place it's
// ever exposed in plaintext.
const extractToken = (loggedUrl) => new URL(loggedUrl.split(': ').slice(1).join(': ')).searchParams.get('token');

describe('POST /api/auth/forgot-password', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('returns a generic success response for an unknown email without setting a token', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('sets a hashed reset token and logs the reset link for a known email', async () => {
    await registerVendor(app);

    const res = await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);

    const vendor = await asTenant(() => Vendor.findOne({ email: baseVendor.email }).select('+resetPasswordToken +resetPasswordExpires'));
    expect(vendor.resetPasswordToken).toEqual(expect.any(String));
    expect(vendor.resetPasswordExpires.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a malformed email with a 400 field error', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.errors.email).toEqual(expect.any(String));
  });
});

describe('POST /api/auth/reset-password', () => {
  let infoSpy;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('resets the password with a valid token and allows login with the new password', async () => {
    await registerVendor(app);
    await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    const loggedUrl = infoSpy.mock.calls[0][0];
    const token = extractToken(loggedUrl);

    const resetRes = await request(app).post('/api/auth/reset-password').send({ token, password: 'newpass456' });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    const loginRes = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: baseVendor.email,
      password: 'newpass456'
    });
    expect(loginRes.status).toBe(200);

    const oldPasswordLogin = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: baseVendor.email,
      password: baseVendor.password
    });
    expect(oldPasswordLogin.status).toBe(401);
  });

  it('rejects an unknown/garbage token with 400', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'not-a-real-token', password: 'newpass456' });
    expect(res.status).toBe(400);
  });

  it('rejects an expired token with 400', async () => {
    await registerVendor(app);
    await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    const loggedUrl = infoSpy.mock.calls[0][0];
    const token = extractToken(loggedUrl);

    // Force the token to have already expired
    await asTenant(() => Vendor.updateOne({ email: baseVendor.email }, { resetPasswordExpires: new Date(Date.now() - 1000) }));

    const res = await request(app).post('/api/auth/reset-password').send({ token, password: 'newpass456' });
    expect(res.status).toBe(400);
  });

  it('rejects a token reused after it has already been consumed', async () => {
    await registerVendor(app);
    await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    const loggedUrl = infoSpy.mock.calls[0][0];
    const token = extractToken(loggedUrl);

    await request(app).post('/api/auth/reset-password').send({ token, password: 'newpass456' });
    const secondAttempt = await request(app).post('/api/auth/reset-password').send({ token, password: 'anotherpass789' });

    expect(secondAttempt.status).toBe(400);
  });
});
