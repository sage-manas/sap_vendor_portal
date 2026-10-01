const request = require('supertest');
const buildTestApp = require('./testApp');
const { rawPrisma } = require('../db/prisma');
const mailer = require('../utils/mailer');
const { drainBackground } = require('../utils/background');
const { baseVendor, seedClient, createAdminUser, asTenant } = require('./helpers');

const app = buildTestApp();

// Finding 1.4. Registration used to answer 409 "already exists" for a taken
// email/GSTIN/ID and hand back a session token on success: the first tells
// anyone which addresses have accounts, and the second means a registration
// proves nothing about who owns the mailbox.
//
// Now registration answers the same 202 whatever it found, does its work after
// answering, and tells the mailbox owner what happened by email. A new account
// cannot sign in until the emailed link is followed, and following it needs the
// password chosen at registration — otherwise whoever pre-registers a victim's
// address could be handed the account when the victim clicks an emailed link.

const register = (overrides = {}) =>
  request(app).post('/api/auth/register').set('x-client-slug', 'legacy').send({ ...baseVendor, ...overrides });

const confirm = (body) => request(app).post('/api/auth/confirm-email').set('x-client-slug', 'legacy').send(body);
const login = (identifier, password = baseVendor.password) =>
  request(app).post('/api/auth/login').set('x-client-slug', 'legacy').send({ vendorIdOrEmail: identifier, password });

const tokenIn = (mail) => {
  const match = /token=([a-f0-9]+)/i.exec(mail.text);
  if (!match) throw new Error(`No token in ${mail.template} mail`);
  return match[1];
};

const mailsTo = (address, template) =>
  mailer.sentMails().filter((mail) => mail.to === address && (!template || mail.template === template));

const pendingRow = (email) => asTenant(() => rawPrisma.vendor.findFirst({
  where: { email },
  omit: { emailVerificationToken: false, emailVerificationExpires: false },
}));

const rowCount = (where) => asTenant(() => rawPrisma.vendor.count({ where }));

beforeEach(async () => {
  mailer.clearMails();
  await seedClient({ slug: 'legacy', clientId: 'CLT-0001' });
});

afterEach(() => drainBackground());

describe('a new registration', () => {
  it('answers 202 with no session, and emails a confirmation link', async () => {
    const res = await register();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, message: expect.any(String) });

    await drainBackground();
    expect(mailsTo(baseVendor.email, 'registrationConfirm')).toHaveLength(1);
    expect(await rowCount({ email: baseVendor.email })).toBe(1);
  });

  it('cannot sign in until the link is followed', async () => {
    await register();
    await drainBackground();

    const res = await login(baseVendor.email);
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('email_unconfirmed');
    expect(res.body.token).toBeUndefined();
  });

  it('is confirmed by the emailed token plus the password chosen at registration', async () => {
    await register();
    await drainBackground();
    const token = tokenIn(mailsTo(baseVendor.email, 'registrationConfirm')[0]);

    expect((await confirm({ token: 'f'.repeat(64), password: baseVendor.password })).status).toBe(400);
    expect((await confirm({ token, password: 'Another-pass-1' })).status).toBe(400);
    expect((await login(baseVendor.email)).status).toBe(403);

    const ok = await confirm({ token, password: baseVendor.password });
    expect(ok.status).toBe(200);

    const session = await login(baseVendor.email);
    expect(session.status).toBe(200);
    expect(session.body.token).toEqual(expect.any(String));
    expect(session.body.vendor.email).toBe(baseVendor.email);

    // Single use.
    expect((await confirm({ token, password: baseVendor.password })).status).toBe(400);
  });
});

describe('registration does not say what already exists', () => {
  const first = { vendorId: 'enum_first', email: 'first@example.com', gstin: '27AAAAA5001A1Z1', pan: 'AAAAA5001A' };

  beforeEach(async () => {
    await register(first);
    await drainBackground();
    const token = tokenIn(mailsTo(first.email, 'registrationConfirm')[0]);
    expect((await confirm({ token, password: baseVendor.password })).status).toBe(200);
    mailer.clearMails();
  });

  it('answers a taken email, GSTIN and vendor ID exactly as it answers a free one', async () => {
    const fresh = await register({ vendorId: 'enum_fresh', email: 'fresh@example.com', gstin: '27AAAAA5002A1Z1', pan: 'AAAAA5002A' });
    const takenEmail = await register({ vendorId: 'enum_b', email: first.email, gstin: '27AAAAA5003A1Z1', pan: 'AAAAA5003A' });
    const takenGstin = await register({ vendorId: 'enum_c', email: 'c@example.com', gstin: first.gstin, pan: 'AAAAA5004A' });
    const takenId = await register({ vendorId: first.vendorId, email: 'd@example.com', gstin: '27AAAAA5005A1Z1', pan: 'AAAAA5005A' });

    for (const res of [takenEmail, takenGstin, takenId]) {
      expect(res.status).toBe(fresh.status);
      expect(res.body).toEqual(fresh.body);
    }
  });

  it('tells the owner of an existing address by email, and creates nothing', async () => {
    await register({ vendorId: 'enum_b', email: first.email, gstin: '27AAAAA5003A1Z1', pan: 'AAAAA5003A' });
    await drainBackground();

    expect(mailsTo(first.email, 'registrationExisting')).toHaveLength(1);
    expect(mailsTo(first.email, 'registrationConfirm')).toHaveLength(0);
    expect(await rowCount({ email: first.email })).toBe(1);
    expect(await rowCount({ vendorId: 'enum_b' })).toBe(0);
  });

  it('tells the submitted address when the company is already registered, and creates nothing', async () => {
    await register({ vendorId: 'enum_c', email: 'c@example.com', gstin: first.gstin, pan: 'AAAAA5004A' });
    await drainBackground();

    expect(mailsTo('c@example.com', 'registrationRefused')).toHaveLength(1);
    expect(await rowCount({ email: 'c@example.com' })).toBe(0);
  });

  it('does not wait for the mail server to answer, new address or known', async () => {
    const sendMail = jest.spyOn(mailer, 'sendMail').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 1000)),
    );
    try {
      const timed = async (overrides) => {
        const started = Date.now();
        const res = await register(overrides);
        return { res, ms: Date.now() - started };
      };

      const fresh = await timed({ vendorId: 'enum_t1', email: 't1@example.com', gstin: '27AAAAA5006A1Z1', pan: 'AAAAA5006A' });
      const known = await timed({ vendorId: 'enum_t2', email: first.email, gstin: '27AAAAA5007A1Z1', pan: 'AAAAA5007A' });

      expect(fresh.res.status).toBe(202);
      expect(known.res.status).toBe(202);
      expect(fresh.ms).toBeLessThan(700);
      expect(known.ms).toBeLessThan(700);
    } finally {
      await drainBackground();
      sendMail.mockRestore();
    }
  });
});

describe('a registration still waiting for its link', () => {
  it('gets a fresh link on a second registration, without extending its life or changing its password', async () => {
    await register();
    await drainBackground();
    const firstToken = tokenIn(mailsTo(baseVendor.email, 'registrationConfirm')[0]);
    const before = await pendingRow(baseVendor.email);

    mailer.clearMails();
    const again = await register({ password: 'Different-pass-9' });
    expect(again.status).toBe(202);
    await drainBackground();

    const mails = mailsTo(baseVendor.email, 'registrationConfirm');
    expect(mails).toHaveLength(1);
    const secondToken = tokenIn(mails[0]);
    expect(secondToken).not.toBe(firstToken);
    expect(await rowCount({ email: baseVendor.email })).toBe(1);

    const after = await pendingRow(baseVendor.email);
    expect(after.emailVerificationExpires.getTime()).toBe(before.emailVerificationExpires.getTime());

    // The superseded link is dead, and the second submission did not take over
    // the account: only the first password confirms it.
    expect((await confirm({ token: firstToken, password: baseVendor.password })).status).toBe(400);
    expect((await confirm({ token: secondToken, password: 'Different-pass-9' })).status).toBe(400);
    expect((await confirm({ token: secondToken, password: baseVendor.password })).status).toBe(200);
  });

  it('frees its email and GSTIN once the link has expired', async () => {
    await register();
    await drainBackground();

    // Time passing is the one thing a test cannot ask the API for.
    await asTenant(() => rawPrisma.vendor.updateMany({
      where: { email: baseVendor.email },
      data: { emailVerificationExpires: new Date(Date.now() - 60 * 1000) },
    }));

    mailer.clearMails();
    await register({ password: 'Second-owner-1' });
    await drainBackground();

    const token = tokenIn(mailsTo(baseVendor.email, 'registrationConfirm')[0]);
    expect(await rowCount({ email: baseVendor.email })).toBe(1);
    expect((await confirm({ token, password: baseVendor.password })).status).toBe(400);
    expect((await confirm({ token, password: 'Second-owner-1' })).status).toBe(200);
  });

  it('is confirmed by resetting the password through the mailbox, which proves it just as well', async () => {
    await register();
    await drainBackground();
    mailer.clearMails();

    await request(app).post('/api/auth/forgot-password').set('x-client-slug', 'legacy').send({ email: baseVendor.email });
    await drainBackground();
    // A pending account still gets a reset link: the mailbox is the proof.
    const resetToken = tokenIn(mailsTo(baseVendor.email, 'passwordReset')[0]);

    const reset = await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: 'Brand-new-pass-1' });
    expect(reset.status).toBe(200);

    expect((await login(baseVendor.email, 'Brand-new-pass-1')).status).toBe(200);
    expect((await pendingRow(baseVendor.email)).emailVerificationToken).toBeNull();
  });
});

describe('a workspace that admits suppliers by invitation only', () => {
  it('answers an uninvited address like any other, and says so by email', async () => {
    const admin = await createAdminUser({ email: 'registration-admin@example.com' });
    const closed = await request(app).patch('/api/workspace/settings')
      .set({ Authorization: `Bearer ${admin.token}` })
      .send({ settings: { 'features.supplierSelfRegistration': false } });
    expect(closed.status).toBe(200);

    const res = await register({ email: 'uninvited@example.com' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true, message: expect.any(String) });

    await drainBackground();
    expect(mailsTo('uninvited@example.com', 'registrationRefused')).toHaveLength(1);
    expect(await rowCount({ email: 'uninvited@example.com' })).toBe(0);
  });
});
