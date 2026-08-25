// Phase 7 — plan enforcement, the billing seam, and the public status page.
const request = require('supertest');
const buildTestApp = require('./testApp');

const Client = require('../models/Client');
const { withoutTenantScope } = require('../utils/tenantContext');
const { ROLES } = require('../config/roles');
const {
  createTenantUser,
  createOperatorSession,
  registerVendor,
  seedClient,
  baseVendor,
} = require('./helpers');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const setLimits = (clientId, limits) => withoutTenantScope(() =>
  Client.updateOne({ clientId }, { $set: Object.fromEntries(Object.entries(limits).map(([k, v]) => [`limits.${k}`, v])) }));

const futureDate = (days = 7) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const rfqPayload = (overrides = {}) => ({
  description: 'Industrial fasteners bulk order',
  deadlineDate: futureDate(),
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 }],
  ...overrides,
});

describe('plan enforcement — vendors', () => {
  it('refuses self-registration once the tenant is at its vendor limit', async () => {
    await seedClient({ clientId: 'CLT-0001', slug: 'legacy' });
    await setLimits('CLT-0001', { vendors: 0 });

    const res = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'legacy')
      .send(baseVendor);

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('plan_limit_reached');
  });

  it('refuses a tenant-created supplier once the vendor limit is reached', async () => {
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });
    await setLimits('CLT-0001', { vendors: 0 });

    const res = await request(app)
      .post('/api/vendors')
      .set(bearer(token))
      .send({
        companyName: 'Over Limit Co',
        gstin: '27AABCO1234F1Z5',
        pan: 'AABCO1234F',
        email: 'overlimit@example.com',
      });

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('plan_limit_reached');
  });

  it('allows registration when the limit has not been reached', async () => {
    await seedClient({ clientId: 'CLT-0001', slug: 'legacy' });
    await setLimits('CLT-0001', { vendors: 5 });

    const res = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'legacy')
      .send(baseVendor);

    expect(res.status).toBe(201);
  });

  it('an unlimited plan (limit 0/unset is treated as unset only when null) still enforces a numeric 0', async () => {
    // limits.vendors defaults to 50 on the schema; explicitly nulling it means unlimited.
    await seedClient({ clientId: 'CLT-0001', slug: 'legacy' });
    await setLimits('CLT-0001', { vendors: null });

    const res = await request(app)
      .post('/api/auth/register')
      .set('x-client-slug', 'legacy')
      .send(baseVendor);

    expect(res.status).toBe(201);
  });
});

describe('plan enforcement — RFQs', () => {
  it('refuses a new RFQ once the monthly limit is reached', async () => {
    const { token } = await createTenantUser({ role: ROLES.BUYER });
    await setLimits('CLT-0001', { rfqsPerMonth: 0 });

    const res = await request(app).post('/api/rfqs').set(bearer(token)).send(rfqPayload());

    expect(res.status).toBe(402);
    expect(res.body.reason).toBe('plan_limit_reached');
  });

  it('allows RFQ creation under the limit and counts toward it', async () => {
    const { token } = await createTenantUser({ role: ROLES.BUYER });
    await setLimits('CLT-0001', { rfqsPerMonth: 1 });

    const first = await request(app).post('/api/rfqs').set(bearer(token)).send(rfqPayload());
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/rfqs').set(bearer(token)).send(rfqPayload());
    expect(second.status).toBe(402);
  });
});

describe('billing seam', () => {
  it('calls the (null) billing provider when a tenant is created, and can report usage on demand', async () => {
    const { token } = await createOperatorSession();

    const created = await request(app)
      .post('/api/platform/tenants')
      .set(bearer(token))
      .send({
        companyName: 'Billing Test Co',
        slug: 'billing-test',
        plan: 'growth',
        admin: { email: 'ops@billing-test.example.com', name: 'Ops' },
      });
    expect(created.status).toBe(201);
    const clientId = created.body.tenant.clientId;

    const res = await request(app)
      .post(`/api/platform/tenants/${clientId}/billing/sync-usage`)
      .set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.billing).toMatchObject({ ok: true, provider: 'null' });
    expect(res.body.usage).toHaveProperty('vendors');
    expect(res.body.usage).toHaveProperty('rfqsThisMonth');
  });

  it('is a platform-only action; a tenant account gets the same 404 as any cross-plane call (ADR-0008)', async () => {
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app)
      .post('/api/platform/tenants/CLT-0001/billing/sync-usage')
      .set(bearer(token));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/status', () => {
  it('answers with aggregate, anonymous counts and no tenant-identifying data', async () => {
    await seedClient({ clientId: 'CLT-0001', slug: 'legacy' });

    const res = await request(app).get('/api/status');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('operational');
    expect(res.body.database).toBe('connected');
    expect(res.body.tenants).toHaveProperty('operational');
    expect(res.body.sap).toHaveProperty('calls');
    // No company name, slug or clientId anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(/CLT-0001|legacy|Legacy/);
  });

  it('renders an HTML page for a browser', async () => {
    const res = await request(app).get('/api/status').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toMatch(/VendorConnect/);
  });

  it('needs no authentication', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
