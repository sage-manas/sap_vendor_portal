const request = require('supertest');
const buildTestApp = require('./testApp');
const User = require('../models/User');
const Vendor = require('../models/Vendor');
const Invitation = require('../models/Invitation');
const {
  registerVendor,
  createTenantUser,
  createAdminUser,
  createPlatformUser,
  seedClient,
  asTenant,
} = require('./helpers');
const { sentMails, lastMailTo, clearMails } = require('../utils/mailer');

const app = buildTestApp();

const bearer = (req, token) => req.set('Authorization', `Bearer ${token}`);
const inviteTokenFor = (email) => /token=([a-f0-9]+)/i.exec(lastMailTo(email).text)[1];

beforeEach(() => clearMails());

describe('tenant staff identity', () => {
  it('a staff user signs in with their email and gets a tenant-plane token', async () => {
    await createTenantUser({ role: 'finance', email: 'fin@example.com' });

    const res = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: 'fin@example.com',
      password: 'secret123',
    });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('finance');
    expect(res.body.user.email).toBe('fin@example.com');
    expect(res.body.user.password).toBeUndefined();

    const me = await bearer(request(app).get('/api/auth/me'), res.body.token);
    expect(me.status).toBe(200);
    expect(me.body.auth.plane).toBe('tenant');
    expect(me.body.auth.permissions).toContain('invoice:approve');
  });

  it('a suspended staff user cannot sign in or use an existing token', async () => {
    const { token, user } = await createTenantUser({ role: 'buyer', email: 'buyer2@example.com' });

    await asTenant(() => User.updateOne({ _id: user._id }, { status: 'Suspended' }));

    const login = await request(app).post('/api/auth/login').send({
      vendorIdOrEmail: 'buyer2@example.com',
      password: 'secret123',
    });
    expect(login.status).toBe(403);

    const withOldToken = await bearer(request(app).get('/api/auth/me'), token);
    expect(withOldToken.status).toBe(403);
  });

  it('a buyer cannot reach finance actions and vice versa', async () => {
    const { token: buyer } = await createTenantUser({ role: 'buyer', email: 'b@example.com' });
    const { token: finance } = await createTenantUser({ role: 'finance', email: 'f@example.com' });

    const buyerPostsPayment = await bearer(request(app).post('/api/payments'), buyer).send({ vendorId: 'x', grossAmount: 10 });
    expect(buyerPostsPayment.status).toBe(403);

    const financeCreatesRfq = await bearer(request(app).post('/api/rfqs'), finance).send({ description: 'x' });
    expect(financeCreatesRfq.status).toBe(403);
  });

  it('a supplier cannot list or manage tenant staff', async () => {
    const { token } = await registerVendor(app);

    expect((await bearer(request(app).get('/api/users'), token)).status).toBe(403);
    expect((await bearer(request(app).post('/api/users/invitations'), token)
      .send({ email: 'x@example.com', role: 'buyer' })).status).toBe(403);
  });

  it('refuses to leave a workspace without an active client_admin', async () => {
    const { token, user } = await createAdminUser({ email: 'solo-admin@example.com' });
    const { user: other } = await createTenantUser({ role: 'buyer', email: 'someone@example.com' });

    const demote = await bearer(request(app).patch(`/api/users/${user._id}`), token).send({ role: 'buyer' });
    expect(demote.status).toBe(400);

    const suspendOther = await bearer(request(app).put(`/api/users/${other._id}/status`), token).send({ status: 'Suspended' });
    expect(suspendOther.status).toBe(200);
  });

  it('answers 404 for another tenant\'s user', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'other', companyName: 'Other Co' });
    const { user: theirs } = await createTenantUser({ role: 'buyer', clientId: 'CLT-0002', email: 'their-buyer@example.com' });
    const { token } = await createAdminUser({ email: 'our-admin@example.com' });

    const res = await bearer(request(app).get(`/api/users/${theirs._id}`), token);
    expect(res.status).toBe(404);
  });
});

describe('invitations', () => {
  it('invites a buyer, emails the link, and creates the account on acceptance', async () => {
    const { token: adminToken } = await createAdminUser({ email: 'admin-inv@example.com' });

    const invite = await bearer(request(app).post('/api/users/invitations'), adminToken)
      .send({ email: 'newbuyer@example.com', name: 'New Buyer', role: 'buyer' });

    expect(invite.status).toBe(201);
    expect(sentMails().some((mail) => mail.template === 'invitation' && mail.to === 'newbuyer@example.com')).toBe(true);

    const rawToken = inviteTokenFor('newbuyer@example.com');

    const preview = await request(app).get(`/api/auth/invitations/${rawToken}`);
    expect(preview.status).toBe(200);
    expect(preview.body.invitation.role).toBe('buyer');

    const accept = await request(app).post('/api/auth/invitations/accept')
      .send({ token: rawToken, password: 'secret123', name: 'New Buyer' });

    expect(accept.status).toBe(201);
    expect(accept.body.user.role).toBe('buyer');

    const me = await bearer(request(app).get('/api/auth/me'), accept.body.token);
    expect(me.body.auth.clientId).toBe('CLT-0001');

    const reuse = await request(app).post('/api/auth/invitations/accept')
      .send({ token: rawToken, password: 'secret123' });
    expect(reuse.status).toBe(400);
  });

  it('refuses to invite a role outside the tenant plane', async () => {
    const { token } = await createAdminUser({ email: 'admin-inv2@example.com' });

    const res = await bearer(request(app).post('/api/users/invitations'), token)
      .send({ email: 'op@example.com', role: 'super_admin' });

    expect(res.status).toBe(400);
  });

  it('a supplier invitation hands off to registration rather than creating a user', async () => {
    const { token } = await createAdminUser({ email: 'admin-inv3@example.com' });

    await bearer(request(app).post('/api/vendors/invitations'), token)
      .send({ email: 'supplier@example.com', name: 'Supplier Co' });

    const rawToken = inviteTokenFor('supplier@example.com');
    const accept = await request(app).post('/api/auth/invitations/accept')
      .send({ token: rawToken, password: 'secret123' });

    expect(accept.status).toBe(200);
    expect(accept.body.next).toBe('register');
    expect(accept.body.workspace.slug).toBe('legacy');
    expect(await asTenant(() => User.countDocuments({ email: 'supplier@example.com' }))).toBe(0);
  });

  it('revoking an invitation makes its link useless', async () => {
    const { token } = await createAdminUser({ email: 'admin-inv4@example.com' });

    const invite = await bearer(request(app).post('/api/users/invitations'), token)
      .send({ email: 'revoked@example.com', role: 'finance' });
    expect(invite.status).toBe(201);

    const rawToken = inviteTokenFor('revoked@example.com');
    const stored = await asTenant(() => Invitation.findOne({ email: 'revoked@example.com' }));

    const revoke = await bearer(request(app).delete(`/api/users/invitations/${stored._id}`), token);
    expect(revoke.status).toBe(200);

    const accept = await request(app).post('/api/auth/invitations/accept')
      .send({ token: rawToken, password: 'secret123' });
    expect(accept.status).toBe(400);
  });

  it('will not invite an email that already holds an account', async () => {
    const { token } = await createAdminUser({ email: 'admin-inv5@example.com' });
    await registerVendor(app);

    const res = await bearer(request(app).post('/api/users/invitations'), token)
      .send({ email: 'acme@example.com', role: 'buyer' });

    expect(res.status).toBe(409);
  });

  it('an invitation belongs to the tenant that issued it', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'other', companyName: 'Other Co' });
    const { token: theirAdmin } = await createTenantUser({ role: 'client_admin', clientId: 'CLT-0002', email: 'their-admin@example.com' });
    const { token: ourAdmin } = await createAdminUser({ email: 'our-admin2@example.com' });

    await bearer(request(app).post('/api/users/invitations'), theirAdmin)
      .send({ email: 'their-invitee@example.com', role: 'buyer' });

    const ourList = await bearer(request(app).get('/api/users/invitations'), ourAdmin);
    expect(ourList.status).toBe(200);
    expect(ourList.body.invitations).toHaveLength(0);

    // Accepting still works — the invitation itself names the tenant.
    const rawToken = inviteTokenFor('their-invitee@example.com');
    const accept = await request(app).post('/api/auth/invitations/accept')
      .send({ token: rawToken, password: 'secret123' });

    expect(accept.status).toBe(201);
    const created = await asTenant(() => User.findOne({ email: 'their-invitee@example.com' }), 'CLT-0002');
    expect(created.clientId).toBe('CLT-0002');
  });
});

describe('platform plane identity', () => {
  it('an operator signs in on their own surface and is refused on the tenant one', async () => {
    await createPlatformUser({ email: 'ops@platform.example.com' });

    const login = await request(app).post('/api/platform/auth/login')
      .send({ email: 'ops@platform.example.com', password: 'secret123' });

    expect(login.status).toBe(200);
    expect(login.body.operator.role).toBe('super_admin');
    expect(login.body.mfaEnrolled).toBe(false);

    const me = await bearer(request(app).get('/api/platform/auth/me'), login.body.token);
    expect(me.status).toBe(200);
    expect(me.body.auth.plane).toBe('platform');
    expect(me.body.auth.clientId).toBeNull();

    const tenantEndpoint = await bearer(request(app).get('/api/rfqs'), login.body.token);
    expect(tenantEndpoint.status).toBe(403);
  });

  it('operator credentials are not accepted at the tenant login', async () => {
    await createPlatformUser({ email: 'ops2@platform.example.com' });

    const res = await request(app).post('/api/auth/login')
      .send({ vendorIdOrEmail: 'ops2@platform.example.com', password: 'secret123' });

    expect(res.status).toBe(401);
  });

  it('tenant credentials are not accepted at the platform login', async () => {
    await createAdminUser({ email: 'admin-plat@example.com' });

    const res = await request(app).post('/api/platform/auth/login')
      .send({ email: 'admin-plat@example.com', password: 'secret123' });

    expect(res.status).toBe(401);
  });

  it('resets an operator password through its own token, and the tenant reset cannot touch it', async () => {
    const { operator } = await createPlatformUser({ email: 'ops3@platform.example.com' });

    const tenantAttempt = await request(app).post('/api/auth/forgot-password')
      .send({ email: 'ops3@platform.example.com' });
    expect(tenantAttempt.status).toBe(200);
    expect(sentMails()).toHaveLength(0);

    await request(app).post('/api/platform/auth/forgot-password')
      .send({ email: 'ops3@platform.example.com' });
    const rawToken = /token=([a-f0-9]+)/i.exec(lastMailTo(operator.email).text)[1];

    const reset = await request(app).post('/api/platform/auth/reset-password')
      .send({ token: rawToken, password: 'brandnew123' });
    expect(reset.status).toBe(200);

    const login = await request(app).post('/api/platform/auth/login')
      .send({ email: 'ops3@platform.example.com', password: 'brandnew123' });
    expect(login.status).toBe(200);
  });
});

describe('forced password change', () => {
  it('is reported at login and cleared by change-password', async () => {
    const { user } = await createTenantUser({ role: 'buyer', email: 'temp@example.com', mustChangePassword: true });
    expect(user.mustChangePassword).toBe(true);

    const login = await request(app).post('/api/auth/login')
      .send({ vendorIdOrEmail: 'temp@example.com', password: 'secret123' });
    expect(login.body.mustChangePassword).toBe(true);

    const wrongCurrent = await bearer(request(app).post('/api/auth/change-password'), login.body.token)
      .send({ currentPassword: 'nope123', newPassword: 'changed123' });
    expect(wrongCurrent.status).toBe(401);

    const changed = await bearer(request(app).post('/api/auth/change-password'), login.body.token)
      .send({ currentPassword: 'secret123', newPassword: 'changed123' });
    expect(changed.status).toBe(200);

    const relogin = await request(app).post('/api/auth/login')
      .send({ vendorIdOrEmail: 'temp@example.com', password: 'changed123' });
    expect(relogin.body.mustChangePassword).toBe(false);
  });

  it('works for suppliers too', async () => {
    const { token } = await registerVendor(app);

    const changed = await bearer(request(app).post('/api/auth/change-password'), token)
      .send({ currentPassword: 'secret123', newPassword: 'changed123' });
    expect(changed.status).toBe(200);

    const stored = await asTenant(() => Vendor.findOne({ email: 'acme@example.com' }).select('+password'));
    expect(await stored.comparePassword('changed123')).toBe(true);
  });
});
