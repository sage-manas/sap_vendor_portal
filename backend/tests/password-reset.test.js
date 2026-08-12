const request = require('supertest');
const buildTestApp = require('./testApp');
const Vendor = require('../models/Vendor');
const { baseVendor, registerVendor, asTenant } = require('./helpers');
const { sentMails, lastMailTo, clearMails } = require('../utils/mailer');

const app = buildTestApp();

// The reset link is emailed and never logged (ADR-0011). Under test the mailer
// uses its in-memory transport, so the token is read back out of the message.
const extractToken = (email) => {
  const match = /token=([a-f0-9]+)/i.exec(email.text);
  if (!match) throw new Error(`No reset token in email: ${email.subject}`);
  return match[1];
};

const tokenSentTo = (address) => extractToken(lastMailTo(address));

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => clearMails());

  it('returns a generic success response for an unknown email without setting a token', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sentMails()).toHaveLength(0);
  });

  it('sets a hashed reset token and emails the reset link for a known email', async () => {
    await registerVendor(app);

    const res = await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(sentMails()).toHaveLength(1);
    expect(sentMails()[0].to).toBe(baseVendor.email);
    expect(sentMails()[0].template).toBe('passwordReset');

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
  beforeEach(() => clearMails());

  it('resets the password with a valid token and allows login with the new password', async () => {
    await registerVendor(app);
    await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    const token = tokenSentTo(baseVendor.email);

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

    const token = tokenSentTo(baseVendor.email);

    // Force the token to have already expired
    await asTenant(() => Vendor.updateOne({ email: baseVendor.email }, { resetPasswordExpires: new Date(Date.now() - 1000) }));

    const res = await request(app).post('/api/auth/reset-password').send({ token, password: 'newpass456' });
    expect(res.status).toBe(400);
  });

  it('rejects a token reused after it has already been consumed', async () => {
    await registerVendor(app);
    await request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email });

    const token = tokenSentTo(baseVendor.email);

    await request(app).post('/api/auth/reset-password').send({ token, password: 'newpass456' });
    const secondAttempt = await request(app).post('/api/auth/reset-password').send({ token, password: 'anotherpass789' });

    expect(secondAttempt.status).toBe(400);
  });
});
