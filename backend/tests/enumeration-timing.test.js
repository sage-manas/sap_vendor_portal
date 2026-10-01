const request = require('supertest');
const bcrypt = require('bcryptjs');
const buildTestApp = require('./testApp');
const mailer = require('../utils/mailer');
const { drainBackground } = require('../utils/background');
const { baseVendor, registerVendor, createPlatformUser } = require('./helpers');

const app = buildTestApp();

// Finding 1.4. A response must not say whether an address has an account, and
// that includes how long it takes to answer. forgot-password used to write a
// token and send an email *before* answering for a real account, and answer at
// once for an unknown one: the difference is the SMTP round trip, which is
// hundreds of milliseconds and easy to measure from outside.

describe('forgot-password answers a real and an unknown address alike, and as quickly', () => {
  let sendMail;

  // A mail server that takes a second. If the response waited for it the two
  // answers would differ by about that much. Installed by the test once its own
  // set-up (registering a supplier sends mail too) is done.
  const slowMailServer = () => {
    mailer.clearMails();
    sendMail = jest.spyOn(mailer, 'sendMail').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 1000)),
    );
  };

  afterEach(async () => {
    await drainBackground();
    if (sendMail) sendMail.mockRestore();
    sendMail = null;
  });

  const timed = async (fn) => {
    const started = Date.now();
    const res = await fn();
    return { res, ms: Date.now() - started };
  };

  it('does not wait for the mail server before answering a tenant account', async () => {
    await registerVendor(app);
    slowMailServer();

    const real = await timed(() => request(app).post('/api/auth/forgot-password').send({ email: baseVendor.email }));
    const unknown = await timed(() => request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' }));

    expect(real.res.status).toBe(200);
    expect(real.res.body).toEqual(unknown.res.body);
    expect(real.ms).toBeLessThan(700);

    // The reset is still sent — just not on the caller's clock.
    await drainBackground();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: baseVendor.email, template: 'passwordReset' });
  });

  it('does not wait for the mail server before answering an operator account', async () => {
    const { operator } = await createPlatformUser({ email: 'operator-timing@example.com' });
    slowMailServer();

    const real = await timed(() => request(app).post('/api/platform/auth/forgot-password').send({ email: operator.email }));
    const unknown = await timed(() => request(app).post('/api/platform/auth/forgot-password').send({ email: 'nobody@example.com' }));

    expect(real.res.status).toBe(200);
    expect(real.res.body).toEqual(unknown.res.body);
    expect(real.ms).toBeLessThan(700);

    await drainBackground();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('login does the same password work whether or not the account exists', () => {
  it('runs one bcrypt comparison for an unknown account and for a wrong password', async () => {
    await registerVendor(app);
    const compare = jest.spyOn(bcrypt, 'compare');

    try {
      const wrong = await request(app).post('/api/auth/login').send({ vendorIdOrEmail: baseVendor.email, password: 'Wrong-pass-1' });
      const wrongCalls = compare.mock.calls.length;

      compare.mockClear();
      const unknown = await request(app).post('/api/auth/login').send({ vendorIdOrEmail: 'nobody@example.com', password: 'Wrong-pass-1' });
      const unknownCalls = compare.mock.calls.length;

      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
      expect(wrongCalls).toBe(1);
      expect(unknownCalls).toBe(1);
    } finally {
      compare.mockRestore();
    }
  });
});
