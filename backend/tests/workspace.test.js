const request = require('supertest');
const buildTestApp = require('./testApp');
const {
  registerVendor,
  createTenantUser,
  createAdminUser,
  createOperatorSession,
  seedClient,
  asTenant,
} = require('./helpers');
const { prisma, rawPrisma } = require('../db/prisma');
const { topLevelFieldsFor } = require('../config/tenantSettings');
const { withoutTenantScope } = require('../utils/tenantContext');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { PLATFORM_ACTOR_LABEL } = require('../utils/auditView');
const { VENDOR_STATUS } = require('../config/statuses');
const { sentMails, lastMailTo, clearMails } = require('../utils/mailer');
const { ROLES } = require('../config/roles');

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

// The tenant back office (Phase 5). Two questions run through every case: does
// a role see only its own tabs' data, and does a tenant see only its own?

const OTHER = { clientId: 'CLT-0002', slug: 'other', companyName: 'Other Ltd' };

const setSetting = async (key, value, clientId = 'CLT-0001') => {
  const { applySettings } = require('../config/tenantSettings');
  const client = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId } }));
  const changed = applySettings(client, { [key]: value });
  const data = Object.fromEntries(topLevelFieldsFor(changed).map((field) => [field, client[field]]));
  return withoutTenantScope(() => rawPrisma.client.update({ where: { pk: client.pk }, data }));
};

beforeEach(() => clearMails());

describe('workspace overview', () => {
  it('counts this tenant only, and measures against its own thresholds', async () => {
    const { token } = await createAdminUser();
    await registerVendor(app, {});
    await seedClient(OTHER);
    await registerVendor(app, {
      vendorId: 'vendor_other_1',
      email: 'other@example.com',
      gstin: '27ZZZZZ1234F1Z5',
      pan: 'ZZZZZ1234F',
      clientId: OTHER.clientId,
    }, { clientSlug: OTHER.slug });

    const res = await request(app).get('/api/workspace/overview').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.workspace.clientId).toBe('CLT-0001');
    expect(res.body.suppliers.total).toBe(1);
    expect(res.body.thresholds.invoiceReviewAmount).toBe(500000);
  });

  it('counts a supplier as overdue once it passes the workspace SLA', async () => {
    const { token } = await createAdminUser();
    const { vendor } = await registerVendor(app, {});
    await setSetting('thresholds.supplierApprovalSlaHours', 2);
    await asTenant(() => prisma.vendor.updateMany({
      where: { vendorId: vendor.vendorId },
      data: { status: VENDOR_STATUS.UNDER_REVIEW, submittedAt: new Date(Date.now() - 5 * 3600 * 1000) },
    }));

    const res = await request(app).get('/api/workspace/overview').set(auth(token));

    expect(res.body.suppliers.awaitingDecision).toBe(1);
    expect(res.body.suppliers.overdueDecision).toBe(1);
  });

  it('is tenant staff only — a supplier holds dashboard:read, not workspace:read', async () => {
    const { token } = await registerVendor(app, {});
    const res = await request(app).get('/api/workspace/overview').set(auth(token));
    expect(res.status).toBe(403);
  });

  it('is refused to platform operators, like every tenant endpoint', async () => {
    const { token } = await createOperatorSession();
    const res = await request(app).get('/api/workspace/overview').set(auth(token));
    expect(res.status).toBe(403);
  });
});

describe('workspace settings', () => {
  it('serves every registry group with its effective value', async () => {
    const { token } = await createTenantUser({ role: ROLES.BUYER });
    const res = await request(app).get('/api/workspace/settings').set(auth(token));

    expect(res.status).toBe(200);
    const keys = res.body.groups.flatMap((group) => group.settings.map((setting) => setting.key));
    expect(keys).toContain('features.supplierChat');
    expect(keys).toContain('thresholds.invoiceReviewAmount');
    // Never set, so the registry's default is what the screen renders.
    const chat = res.body.groups
      .flatMap((group) => group.settings)
      .find((setting) => setting.key === 'features.supplierChat');
    expect(chat.value).toBe(true);
  });

  it('lets a client_admin change a setting and records what changed', async () => {
    const { token } = await createAdminUser();

    const res = await request(app)
      .patch('/api/workspace/settings')
      .set(auth(token))
      .send({ settings: { 'thresholds.invoiceReviewAmount': 250000, 'branding.primaryColor': '#2f6f4e' } });

    expect(res.status).toBe(200);
    expect(res.body.changed.sort()).toEqual(['branding.primaryColor', 'thresholds.invoiceReviewAmount']);
    expect(res.body.workspace.branding.primaryColor).toBe('#2f6f4e');

    const client = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } }));
    expect(client.settings.thresholds.invoiceReviewAmount).toBe(250000);

    const entry = await rawPrisma.auditLog.findFirst({ where: { action: AUDIT_ACTIONS.SETTINGS_UPDATED } });
    expect(entry.clientId).toBe('CLT-0001');
    expect(entry.meta.changed).toContain('branding.primaryColor');
  });

  it('reports which key was wrong rather than half-applying the patch', async () => {
    const { token } = await createAdminUser();

    const res = await request(app)
      .patch('/api/workspace/settings')
      .set(auth(token))
      .send({ settings: { 'branding.primaryColor': 'chartreuse', 'thresholds.invoiceReviewAmount': 1 } });

    expect(res.status).toBe(400);
    expect(res.body.errors['branding.primaryColor']).toMatch(/hex colour/);

    const client = await withoutTenantScope(() => rawPrisma.client.findFirst({ where: { clientId: 'CLT-0001' } }));
    expect(client.settings?.thresholds?.invoiceReviewAmount).toBeUndefined();
  });

  it('refuses a key that is not in the registry', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .patch('/api/workspace/settings')
      .set(auth(token))
      .send({ settings: { 'limits.vendors': 9999 } });

    expect(res.status).toBe(400);
    expect(res.body.errors['limits.vendors']).toBeDefined();
  });

  it('is read-only for a buyer', async () => {
    const { token } = await createTenantUser({ role: ROLES.BUYER });
    const res = await request(app)
      .patch('/api/workspace/settings')
      .set(auth(token))
      .send({ settings: { 'thresholds.invoiceReviewAmount': 1 } });

    expect(res.status).toBe(403);
  });
});

describe('feature flags close the API, not just the screen', () => {
  it('answers 404 on messaging for a tenant that switched it off, and 200 for one that did not', async () => {
    // Both onboarded: this is about the feature flag, and the onboarding gate
    // would otherwise refuse messaging first, for both tenants alike.
    const { token } = await registerVendor(app, {}, { onboarded: true });
    await seedClient(OTHER);
    const { token: otherToken } = await registerVendor(app, {
      clientId: OTHER.clientId,
      vendorId: 'vendor_other_2',
      email: 'other2@example.com',
      gstin: '27YYYYY1234F1Z5',
      pan: 'YYYYY1234F',
    }, { clientSlug: OTHER.slug, onboarded: true });

    await setSetting('features.supplierChat', false);

    expect((await request(app).get('/api/chats').set(auth(token))).status).toBe(404);
    expect((await request(app).get('/api/chats').set(auth(otherToken))).status).toBe(200);
  });

  it('closes self-registration but still admits an invited supplier', async () => {
    const { token: adminToken } = await createAdminUser();
    await setSetting('features.supplierSelfRegistration', false);

    const walkIn = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'legacy')
      .send({
        vendorId: 'VND-90001', password: 'secret123', companyName: 'Walk In Ltd',
        gstin: '27WWWWW1234F1Z5', pan: 'WWWWW1234F', email: 'walkin@example.com',
      });
    expect(walkIn.status).toBe(403);

    await request(app)
      .post('/api/vendors/invitations')
      .set(auth(adminToken))
      .send({ email: 'invited@example.com', name: 'Invited Ltd' })
      .expect(201);

    const invited = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'legacy')
      .send({
        vendorId: 'VND-90002', password: 'secret123', companyName: 'Invited Ltd',
        gstin: '27VVVVV1234F1Z5', pan: 'VVVVV1234F', email: 'invited@example.com',
      });
    expect(invited.status).toBe(201);
  });
});

describe('supplier directory', () => {
  const supplierPayload = {
    companyName: 'Directory Supplies Pvt Ltd',
    gstin: '27DDDDD1234F1Z5',
    pan: 'DDDDD1234F',
    email: 'directory@example.com',
    phone: '9876543211',
    address: '4 Industrial Estate',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411002',
  };

  it('creates a supplier the tenant vouches for and emails them a link to claim it', async () => {
    const { token } = await createAdminUser();

    const res = await request(app).post('/api/vendors').set(auth(token)).send(supplierPayload);

    expect(res.status).toBe(201);
    expect(res.body.vendor.status).toBe(VENDOR_STATUS.DRAFT);
    expect(res.body.vendor.vendorId).toMatch(/^VND-\d{5}$/);
    expect(res.body.vendor.password).toBeUndefined();

    const created = await asTenant(() => prisma.vendor.findFirst({ where: { email: supplierPayload.email } }));
    expect(created.clientId).toBe('CLT-0001');
    expect(created.mustChangePassword).toBe(true);

    const mail = lastMailTo(supplierPayload.email);
    expect(mail.template).toBe('supplierWelcome');
    // The link is emailed; the password is not, because there is not one.
    expect(mail.text).not.toMatch(/password:/i);

    const entry = await rawPrisma.auditLog.findFirst({ where: { action: AUDIT_ACTIONS.VENDOR_CREATED } });
    expect(entry.target.label).toBe(supplierPayload.companyName);
  });

  it('uses the same validation as self-registration', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .post('/api/vendors')
      .set(auth(token))
      .send({ ...supplierPayload, gstin: 'nonsense' });

    expect(res.status).toBe(400);
  });

  it('refuses an email that already belongs to an account in any tenant', async () => {
    const { token } = await createAdminUser();
    await seedClient(OTHER);
    await registerVendor(app, {
      vendorId: 'vendor_other_3',
      email: supplierPayload.email,
      gstin: '27XXXXX1234F1Z5',
      pan: 'XXXXX1234F',
    }, { clientSlug: OTHER.slug });

    const res = await request(app).post('/api/vendors').set(auth(token)).send(supplierPayload);
    expect(res.status).toBe(409);
  });

  it('is closed to a buyer', async () => {
    const { token } = await createTenantUser({ role: ROLES.BUYER });
    const res = await request(app).post('/api/vendors').set(auth(token)).send(supplierPayload);
    expect(res.status).toBe(403);
  });

  it('searches and filters by the registry statuses', async () => {
    const { token } = await createAdminUser();
    await registerVendor(app, {});

    const found = await request(app).get('/api/vendors?search=Acme').set(auth(token));
    expect(found.body.vendors).toHaveLength(1);

    const none = await request(app).get('/api/vendors?search=Nothing').set(auth(token));
    expect(none.body.vendors).toHaveLength(0);

    const bad = await request(app).get('/api/vendors?status=Almost').set(auth(token));
    expect(bad.status).toBe(400);
  });

  it('tells the supplier what was decided, unless the workspace turned that off', async () => {
    const { token } = await createAdminUser();
    const { vendor } = await registerVendor(app, {});
    await asTenant(() => prisma.vendor.updateMany({
      where: { vendorId: vendor.vendorId },
      data: {
        status: VENDOR_STATUS.UNDER_REVIEW,
        gstinVerified: true,
        panVerified: true,
        verifiedAt: new Date(),
      },
    }));
    const stored = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: vendor.vendorId } }));

    await request(app)
      .put(`/api/vendors/${stored.pk}/reject`)
      .set(auth(token))
      .send({ reason: 'GST certificate is illegible' })
      .expect(200);

    const mail = lastMailTo(stored.email);
    expect(mail.template).toBe('supplierDecision');
    expect(mail.text).toMatch(/illegible/);
    expect(await rawPrisma.auditLog.findFirst({ where: { action: AUDIT_ACTIONS.VENDOR_REJECTED } })).not.toBeNull();

    clearMails();
    await setSetting('notifications.supplierDecisionEmail', false);
    await asTenant(() => prisma.vendor.updateMany({ where: { pk: stored.pk }, data: { status: VENDOR_STATUS.UNDER_REVIEW } }));

    await request(app)
      .put(`/api/vendors/${stored.pk}/reject`)
      .set(auth(token))
      .send({ reason: 'Still illegible' })
      .expect(200);

    expect(sentMails()).toHaveLength(0);
  });
});

describe('workspace audit', () => {
  it('shows this tenant its own trail and nothing else', async () => {
    const { token } = await createAdminUser();
    await seedClient(OTHER);
    await recordAudit({
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      clientId: OTHER.clientId,
      actor: { actorId: 'someone', actorRole: ROLES.CLIENT_ADMIN, actorEmail: 'admin@other.example.com', plane: 'tenant' },
    });

    await request(app)
      .patch('/api/workspace/settings')
      .set(auth(token))
      .send({ settings: { 'thresholds.invoiceReviewAmount': 123 } })
      .expect(200);

    const res = await request(app).get('/api/workspace/audit').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].clientId).toBe('CLT-0001');
  });

  it('ignores a clientId in the query — the tenant comes from the token', async () => {
    const { token } = await createAdminUser();
    await seedClient(OTHER);
    await recordAudit({
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      clientId: OTHER.clientId,
      actor: { actorId: 'someone', actorRole: ROLES.CLIENT_ADMIN, actorEmail: 'admin@other.example.com', plane: 'tenant' },
    });

    const res = await request(app).get(`/api/workspace/audit?clientId=${OTHER.clientId}`).set(auth(token));
    expect(res.body.entries).toHaveLength(0);
  });

  it('says an operator acted without saying which operator', async () => {
    const { token } = await createAdminUser();
    await recordAudit({
      action: AUDIT_ACTIONS.TENANT_SUSPENDED,
      clientId: 'CLT-0001',
      actor: { actorId: 'op-1', actorRole: ROLES.SUPER_ADMIN, actorEmail: 'operator@platform.example.com', plane: 'platform' },
    });

    const res = await request(app).get('/api/workspace/audit').set(auth(token));
    const entry = res.body.entries.find((row) => row.action === AUDIT_ACTIONS.TENANT_SUSPENDED);

    expect(entry.actor.role).toBe(PLATFORM_ACTOR_LABEL);
    expect(entry.actor.email).toBeNull();
    expect(entry.ip).toBeUndefined();
  });

  it('is closed to a buyer and to a supplier', async () => {
    const { token: buyer } = await createTenantUser({ role: ROLES.BUYER });
    const { token: supplier } = await registerVendor(app, {});

    expect((await request(app).get('/api/workspace/audit').set(auth(buyer))).status).toBe(403);
    expect((await request(app).get('/api/workspace/audit').set(auth(supplier))).status).toBe(403);
  });

  it('records staff changes as they happen', async () => {
    const { token } = await createAdminUser();
    const { user } = await createTenantUser({ role: ROLES.BUYER, email: 'buyer2@example.com' });

    await request(app)
      .patch(`/api/users/${user.pk}`)
      .set(auth(token))
      .send({ role: ROLES.FINANCE })
      .expect(200);

    const res = await request(app).get('/api/workspace/audit?subject=user').set(auth(token));
    const entry = res.body.entries.find((row) => row.action === AUDIT_ACTIONS.USER_UPDATED);
    expect(entry.meta.role).toEqual({ from: ROLES.BUYER, to: ROLES.FINANCE });
  });
});

describe('invitations remain tenant-scoped', () => {
  it('does not let one tenant see another tenant\'s pending invitations', async () => {
    const { token } = await createAdminUser();
    await seedClient(OTHER);
    const { token: otherAdmin } = await createTenantUser({
      role: ROLES.CLIENT_ADMIN, clientId: OTHER.clientId, email: 'admin@other.example.com',
    });

    await request(app)
      .post('/api/users/invitations')
      .set(auth(otherAdmin))
      .send({ email: 'newbuyer@other.example.com', name: 'New Buyer', role: ROLES.BUYER })
      .expect(201);

    const res = await request(app).get('/api/users/invitations').set(auth(token));
    expect(res.body.invitations).toHaveLength(0);
    expect(await withoutTenantScope(() => rawPrisma.invitation.count({}))).toBe(1);
  });
});
