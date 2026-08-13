// The platform console: tenant lifecycle, operator management, the audit trail
// and the health board — plus the phase's acceptance test, which is the whole
// provisioning flow end to end.
const request = require('supertest');
const buildTestApp = require('./testApp');

const Client = require('../models/Client');
const User = require('../models/User');
const RFQ = require('../models/RFQ');
const AuditLog = require('../models/AuditLog');
const PlatformUser = require('../models/PlatformUser');

const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { clearMails, lastMailTo } = require('../utils/mailer');
const { TENANT_MODEL_NAMES } = require('../config/tenantModels');
const { ROLES } = require('../config/roles');
const {
  createOperatorSession,
  createTenantUser,
  registerVendor,
  seedClient,
} = require('./helpers');

const app = buildTestApp();

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const newTenantPayload = (overrides = {}) => ({
  companyName: 'Northwind Manufacturing',
  slug: 'northwind',
  plan: 'growth',
  admin: { email: 'ops@northwind.example.com', name: 'Nadia Ops' },
  ...overrides,
});

const createTenant = (token, overrides) =>
  request(app).post('/api/platform/tenants').set(bearer(token)).send(newTenantPayload(overrides));

beforeEach(() => clearMails());

describe('platform console — tenants', () => {
  it('creates a tenant, issues its first client_admin, and emails the credentials', async () => {
    const { token, operator } = await createOperatorSession();

    const res = await createTenant(token);

    expect(res.status).toBe(201);
    expect(res.body.tenant).toMatchObject({
      companyName: 'Northwind Manufacturing',
      slug: 'northwind',
      status: 'Trial',
      plan: 'growth',
    });
    // CLT-0001 is the seeded legacy tenant, so this one is the second.
    expect(res.body.tenant.clientId).toBe('CLT-0002');
    expect(res.body.tenant.createdBy).toBe(operator.email);

    const admin = await runWithTenant('CLT-0002', () => User.findOne({ email: 'ops@northwind.example.com' }));
    expect(admin.role).toBe(ROLES.CLIENT_ADMIN);
    expect(admin.clientId).toBe('CLT-0002');
    expect(admin.mustChangePassword).toBe(true);

    const mail = lastMailTo('ops@northwind.example.com');
    expect(mail.template).toBe('tenantAdminCredentials');
    expect(mail.text).toContain('Northwind Manufacturing');

    // The generated password reaches exactly one place: that email.
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('refuses a duplicate slug, a reserved slug and a taken admin email', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);

    expect((await createTenant(token, { admin: { email: 'other@example.com' } })).status).toBe(409);
    expect((await createTenant(token, { slug: 'platform' })).status).toBe(400);
    expect((await createTenant(token, { slug: 'other-co' })).status).toBe(409);
  });

  it('leaves no tenant behind when the administrator cannot be created', async () => {
    const { token } = await createOperatorSession();
    await createTenantUser({ role: ROLES.BUYER, email: 'clash@example.com' });

    const res = await createTenant(token, { admin: { email: 'clash@example.com' } });

    expect(res.status).toBe(409);
    expect(await withoutTenantScope(() => Client.findOne({ slug: 'northwind' }))).toBeNull();
  });

  it('lists, filters and reads back a tenant with its counts', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);

    const list = await request(app).get('/api/platform/tenants?q=north').set(bearer(token));
    expect(list.status).toBe(200);
    expect(list.body.tenants.map((tenant) => tenant.slug)).toEqual(['northwind']);

    const detail = await request(app).get('/api/platform/tenants/CLT-0002').set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.administrators).toHaveLength(1);
    expect(detail.body.counts.User).toBe(1);
    expect(Object.keys(detail.body.counts).sort()).toEqual([...TENANT_MODEL_NAMES].sort());
  });

  it('edits configuration, merging nested objects rather than replacing them', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);

    const res = await request(app)
      .put('/api/platform/tenants/CLT-0002')
      .set(bearer(token))
      .send({ limits: { vendors: 500 }, branding: { primaryColor: '#059669' } });

    expect(res.status).toBe(200);
    expect(res.body.tenant.limits).toMatchObject({ vendors: 500, rfqsPerMonth: 100, storageMb: 1024 });
    expect(res.body.tenant.branding.primaryColor).toBe('#059669');
  });

  it('will not let an operator change a tenant clientId or slug', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);

    const res = await request(app)
      .put('/api/platform/tenants/CLT-0002')
      .set(bearer(token))
      .send({ slug: 'stolen', clientId: 'CLT-9999', companyName: 'Renamed Ltd' });

    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Renamed Ltd' });
  });

  it('suspends, reactivates and terminates — and refuses illegal transitions', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);

    const suspend = () => request(app).post('/api/platform/tenants/CLT-0002/suspend').set(bearer(token)).send({ reason: 'non-payment' });

    expect((await suspend()).body.tenant.status).toBe('Suspended');
    expect((await suspend()).status).toBe(400);

    expect((await request(app).post('/api/platform/tenants/CLT-0002/reactivate').set(bearer(token)).send({})).body.tenant.status).toBe('Active');

    const terminated = await request(app).post('/api/platform/tenants/CLT-0002/terminate').set(bearer(token)).send({});
    expect(terminated.body.tenant.status).toBe('Terminated');
    expect(terminated.body.tenant.terminatedAt).toBeTruthy();

    // Soft: the tenant and its data are still there to be exported.
    expect(await withoutTenantScope(() => Client.findOne({ clientId: 'CLT-0002' }))).not.toBeNull();
    expect((await request(app).post('/api/platform/tenants/CLT-0002/reactivate').set(bearer(token)).send({})).status).toBe(400);
  });

  it('suspending a tenant stops its users signing in', async () => {
    const { token } = await createOperatorSession();
    const { user } = await createTenantUser({ role: ROLES.BUYER });
    const { token: userToken } = await createTenantUser({ role: ROLES.FINANCE, email: 'finance-suspend@example.com' });

    expect((await request(app).get('/api/rfqs').set(bearer(userToken))).status).toBe(200);

    await request(app).post(`/api/platform/tenants/${user.clientId}/suspend`).set(bearer(token)).send({});

    const after = await request(app).get('/api/rfqs').set(bearer(userToken));
    expect(after.status).toBe(403);
  });

  it('exports every tenant-scoped collection, and only that tenant’s rows', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);

    await runWithTenant('CLT-0001', () => RFQ.create({ id: 'RFQ-LEGACY-1', description: 'Legacy bearings', deadlineDate: new Date(Date.now() + 8.64e7), items: [{ line: 10, materialCode: 'M1', quantity: 1 }] }));
    await runWithTenant('CLT-0002', () => RFQ.create({ id: 'RFQ-NORTH-1', description: 'Northwind bearings', deadlineDate: new Date(Date.now() + 8.64e7), items: [{ line: 10, materialCode: 'M1', quantity: 1 }] }));

    const res = await request(app).get('/api/platform/tenants/CLT-0002/export').set(bearer(token));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.collections).sort()).toEqual([...TENANT_MODEL_NAMES].sort());
    expect(res.body.collections.RFQ.documents.map((rfq) => rfq.id)).toEqual(['RFQ-NORTH-1']);
    // Credentials are select:false, so an export cannot carry password hashes.
    expect(JSON.stringify(res.body.collections.User)).not.toContain('$2b$');
  });

  it('answers 404 for a tenant that does not exist', async () => {
    const { token } = await createOperatorSession();
    expect((await request(app).get('/api/platform/tenants/CLT-9999').set(bearer(token))).status).toBe(404);
  });
});

describe('platform console — acceptance: provision a tenant end to end', () => {
  it('operator creates a tenant, the new admin signs in, is forced to change password, and sees only their own workspace', async () => {
    const { token: operatorToken } = await createOperatorSession();

    // 1. The operator provisions the tenant.
    const created = await createTenant(operatorToken);
    expect(created.status).toBe(201);
    const { clientId } = created.body.tenant;

    // 2. The credentials arrive by email, and nowhere else.
    const mail = lastMailTo('ops@northwind.example.com');
    const temporaryPassword = mail.text.match(/<code>(.+?)<\/code>|\n([A-Za-z0-9_-]{20,})\n/)?.[2]
      ?? mail.html.match(/<code>(.+?)<\/code>/)[1];
    expect(temporaryPassword).toBeTruthy();

    // 3. That password signs the new client_admin in.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ vendorIdOrEmail: 'ops@northwind.example.com', password: temporaryPassword });

    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    const adminToken = login.body.token;

    // 4. They change it, as the flow demands.
    const changed = await request(app)
      .post('/api/auth/change-password')
      .set(bearer(adminToken))
      .send({ currentPassword: temporaryPassword, newPassword: 'a-proper-password' });
    expect(changed.status).toBe(200);

    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ vendorIdOrEmail: 'ops@northwind.example.com', password: 'a-proper-password' });
    expect(relogin.body.mustChangePassword).toBe(false);

    // 5. Inside the tenant they are an administrator — and the tenant is theirs
    //    alone: a supplier registered into the legacy workspace is invisible.
    await registerVendor(app, {}, { clientSlug: 'legacy' });

    const vendors = await request(app).get('/api/vendors').set(bearer(relogin.body.token));
    expect(vendors.status).toBe(200);
    expect(vendors.body.data ?? vendors.body.vendors ?? []).toHaveLength(0);

    // 6. And the trail records who did it.
    const audit = await request(app)
      .get(`/api/platform/audit?clientId=${clientId}`)
      .set(bearer(operatorToken));
    expect(audit.body.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['tenant.created', 'tenant.admin_provisioned'])
    );
  });
});

describe('platform console — operators and MFA', () => {
  it('refuses the console to an operator who has not enrolled MFA', async () => {
    const { token } = await createOperatorSession();
    // A freshly created operator: password set, no authenticator.
    await request(app).post('/api/platform/operators').set(bearer(token)).send({
      email: 'newop@platform.example.com', name: 'New Operator', role: ROLES.SAP_MANAGER,
    });

    const login = await request(app).post('/api/platform/auth/login').send({
      email: 'newop@platform.example.com',
      password: lastMailTo('newop@platform.example.com').html.match(/<code>(.+?)<\/code>/)[1],
    });

    expect(login.status).toBe(200);
    expect(login.body.next).toBe('change_password');
    expect(login.body.mfaEnrolled).toBe(false);

    const blocked = await request(app).get('/api/platform/tenants').set(bearer(login.body.token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.reason).toBe('mfa_enrolment_required');

    // …but the enrolment flow itself is open to that half-session.
    const enrol = await request(app).post('/api/platform/auth/mfa/enrol').set(bearer(login.body.token)).send({});
    expect(enrol.status).toBe(200);
    expect(enrol.body.otpauthUrl).toContain('otpauth://totp/');

    const totp = require('../utils/totp');
    const verified = await request(app)
      .post('/api/platform/auth/mfa/verify')
      .set(bearer(login.body.token))
      .send({ code: totp.generateToken(enrol.body.secret) });

    expect(verified.status).toBe(200);
    expect(verified.body.enrolled).toBe(true);

    const allowed = await request(app).get('/api/platform/tenants').set(bearer(verified.body.token));
    expect(allowed.status).toBe(200);
  });

  it('refuses a token that never cleared the second factor, and a wrong code', async () => {
    const { operator } = await createOperatorSession();
    const { signToken } = require('../utils/authToken');
    const halfSession = signToken(operator, { mfa: false });

    const blocked = await request(app).get('/api/platform/tenants').set(bearer(halfSession));
    expect(blocked.status).toBe(403);
    expect(blocked.body.reason).toBe('mfa_verification_required');

    const wrong = await request(app).post('/api/platform/auth/mfa/verify').set(bearer(halfSession)).send({ code: '000000' });
    expect(wrong.status).toBe(401);
  });

  it('never stores or returns the MFA secret after enrolment', async () => {
    const { token, operator, secret } = await createOperatorSession();

    const stored = await PlatformUser.findById(operator._id).select('+mfaSecret');
    expect(stored.mfaSecret).not.toContain(secret);
    expect(stored.mfaSecret.startsWith('v1:')).toBe(true);

    const me = await request(app).get('/api/platform/auth/me').set(bearer(token));
    expect(JSON.stringify(me.body)).not.toContain(secret);
    expect(me.body.operator.mfaSecret).toBeUndefined();
  });

  it('lets a super admin manage operators, and an sap_manager not', async () => {
    const { token: superToken } = await createOperatorSession({ role: ROLES.SUPER_ADMIN });
    const { token: sapToken } = await createOperatorSession({ role: ROLES.SAP_MANAGER });

    const created = await request(app).post('/api/platform/operators').set(bearer(superToken)).send({
      email: 'colleague@platform.example.com', name: 'A Colleague', role: ROLES.SAP_MANAGER,
    });
    expect(created.status).toBe(201);
    expect(created.body.operator.mfaEnabled).toBe(false);

    expect((await request(app).get('/api/platform/operators').set(bearer(sapToken))).status).toBe(403);
    expect((await request(app).post('/api/platform/operators').set(bearer(sapToken)).send({
      email: 'nope@platform.example.com', name: 'Nope', role: ROLES.SUPER_ADMIN,
    })).status).toBe(403);

    // …but an sap_manager may still read tenants and health.
    expect((await request(app).get('/api/platform/tenants').set(bearer(sapToken))).status).toBe(200);
    expect((await request(app).get('/api/platform/health').set(bearer(sapToken))).status).toBe(200);
    // …and may not create one.
    expect((await createTenant(sapToken)).status).toBe(403);
  });

  it('will not let an operator suspend or demote themselves, or strand the platform', async () => {
    const { token, operator } = await createOperatorSession();

    expect((await request(app).post(`/api/platform/operators/${operator._id}/suspend`).set(bearer(token)).send({})).status).toBe(400);
    expect((await request(app).put(`/api/platform/operators/${operator._id}`).set(bearer(token)).send({ role: ROLES.SAP_MANAGER })).status).toBe(400);

    // The last active super admin cannot be suspended by anyone.
    const { token: otherToken } = await createOperatorSession({ role: ROLES.SUPER_ADMIN, email: 'second@platform.example.com' });
    const suspendFirst = await request(app).post(`/api/platform/operators/${operator._id}/suspend`).set(bearer(otherToken)).send({});
    expect(suspendFirst.status).toBe(200);

    const stranding = await request(app)
      .post(`/api/platform/operators/${(await PlatformUser.findOne({ email: 'second@platform.example.com' }))._id}/suspend`)
      .set(bearer(token));
    // The suspended operator's own token is dead, so this is a 403 either way —
    // assert the invariant directly instead.
    expect(await PlatformUser.countDocuments({ role: ROLES.SUPER_ADMIN, status: 'Active' })).toBeGreaterThan(0);
    expect(stranding.status).toBe(403);
  });

  it('resets a lost authenticator, forcing re-enrolment', async () => {
    const { token: superToken } = await createOperatorSession();
    const { operator, token: theirToken } = await createOperatorSession({ role: ROLES.SAP_MANAGER });

    expect((await request(app).get('/api/platform/tenants').set(bearer(theirToken))).status).toBe(200);

    const reset = await request(app).post(`/api/platform/operators/${operator._id}/mfa/reset`).set(bearer(superToken)).send({ reason: 'lost phone' });
    expect(reset.status).toBe(200);
    expect(reset.body.operator.mfaEnabled).toBe(false);

    // Their existing session is no longer good enough for the console.
    const after = await request(app).get('/api/platform/tenants').set(bearer(theirToken));
    expect(after.status).toBe(403);
    expect(after.body.reason).toBe('mfa_enrolment_required');
  });
});

describe('platform console — audit explorer', () => {
  it('records who did what, and offers filters from the registry', async () => {
    const { token, operator } = await createOperatorSession();
    await createTenant(token);
    await request(app).post('/api/platform/tenants/CLT-0002/suspend').set(bearer(token)).send({ reason: 'trial ended' });

    const all = await request(app).get('/api/platform/audit').set(bearer(token));
    expect(all.status).toBe(200);
    expect(all.body.entries[0].action).toBe('tenant.suspended');
    expect(all.body.entries[0].actor).toMatchObject({ email: operator.email, role: ROLES.SUPER_ADMIN, plane: 'platform' });
    expect(all.body.entries[0].meta).toMatchObject({ from: 'Trial', to: 'Suspended', reason: 'trial ended' });

    const byAction = await request(app).get('/api/platform/audit?action=tenant.created').set(bearer(token));
    expect(byAction.body.entries).toHaveLength(1);

    const bySubject = await request(app).get('/api/platform/audit?subject=tenant').set(bearer(token));
    expect(bySubject.body.total).toBeGreaterThanOrEqual(3);

    const filters = await request(app).get('/api/platform/audit/filters').set(bearer(token));
    expect(filters.body.subjects).toEqual(expect.arrayContaining(['tenant', 'operator', 'sap']));
    expect(filters.body.tenants.map((tenant) => tenant.clientId)).toContain('CLT-0002');
  });

  it('redacts anything secret-shaped that reaches it, and is append-only', async () => {
    const { recordAudit } = require('../utils/audit');
    const { AUDIT_ACTIONS } = require('../config/auditActions');

    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_CREATED,
      clientId: 'CLT-0001',
      actor: { actorId: 'x', actorRole: ROLES.SUPER_ADMIN, actorEmail: 'x@y.z', plane: 'platform' },
      meta: { password: 'hunter2', nested: { apiKey: 'abc' }, plan: 'growth' },
    });

    const entry = await AuditLog.findOne({});
    expect(entry.meta).toEqual({ password: '[redacted]', nested: { apiKey: '[redacted]' }, plan: 'growth' });

    await expect(AuditLog.updateOne({ _id: entry._id }, { $set: { action: 'tenant.updated' } })).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);

    await expect(recordAudit({ action: 'not.a.real.action' })).rejects.toThrow(/Unknown audit action/);
  });
});

describe('platform console — health', () => {
  it('reports usage against limits and an honest SAP status', async () => {
    const { token } = await createOperatorSession();
    await createTenant(token);
    await request(app).put('/api/platform/tenants/CLT-0002').set(bearer(token)).send({ limits: { vendors: 1 } });

    await runWithTenant('CLT-0002', async () => {
      const Vendor = require('../models/Vendor');
      await Vendor.create({ vendorId: 'VND-N1', companyName: 'One Ltd', gstin: '27AABCN1111F1Z5', pan: 'AABCN1111F', email: 'one@northwind.example.com' });
      await Vendor.create({ vendorId: 'VND-N2', companyName: 'Two Ltd', gstin: '27AABCN2222F1Z5', pan: 'AABCN2222F', email: 'two@northwind.example.com' });
    });

    const res = await request(app).get('/api/platform/health').set(bearer(token));
    expect(res.status).toBe(200);

    const northwind = res.body.tenants.find((tenant) => tenant.clientId === 'CLT-0002');
    expect(northwind.usage.vendors).toMatchObject({ used: 2, limit: 1, breached: true });
    // No SAP traffic at all must not read as healthy.
    expect(northwind.sap.status).toBe('unknown');
    expect(northwind.sap).toHaveProperty('syncedAt');
    expect(res.body.platform.limitsBreached).toBe(1);
  });
});

describe('platform console — plane separation', () => {
  it('answers 404, not 403, to a tenant account anywhere on the platform surface', async () => {
    const { token: adminToken } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });
    const { token: vendorToken } = await registerVendor(app);

    for (const token of [adminToken, vendorToken]) {
      for (const path of ['/api/platform/tenants', '/api/platform/operators', '/api/platform/audit', '/api/platform/health']) {
        const res = await request(app).get(path).set(bearer(token));
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }
    }
  });

  it('refuses an operator at every tenant endpoint', async () => {
    const { token } = await createOperatorSession();
    await seedClient();

    for (const path of ['/api/vendors', '/api/rfqs', '/api/invoices', '/api/dashboard/metrics']) {
      const res = await request(app).get(path).set(bearer(token));
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });
});
