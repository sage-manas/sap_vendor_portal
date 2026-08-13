const request = require('supertest');
const buildTestApp = require('./testApp');
const Client = require('../models/Client');
const { withoutTenantScope } = require('../utils/tenantContext');
const { realmFromRequest } = require('../utils/resolveClient');
const { registerVendor, seedClient, baseVendor } = require('./helpers');

// The supplier plane under tenancy: which workspace a signed-out visitor is
// addressing, and what that answer is allowed to decide.

const app = buildTestApp();

const asRequest = (headers) => ({ headers });

describe('realm resolution', () => {
  it('reads the tenant from a subdomain', () => {
    expect(realmFromRequest(asRequest({ host: 'northwind.vendorconnect.io' })))
      .toEqual({ slug: 'northwind', source: 'subdomain' });
  });

  it('follows the proxy hostname ahead of the origin one', () => {
    const realm = realmFromRequest(asRequest({
      'x-forwarded-host': 'northwind.vendorconnect.io',
      host: 'internal-lb:5000',
    }));
    expect(realm).toEqual({ slug: 'northwind', source: 'subdomain' });
  });

  it('does not read a tenant out of the console or marketing hostnames', () => {
    for (const host of ['platform.vendorconnect.io', 'www.vendorconnect.io', 'api.vendorconnect.io']) {
      expect(realmFromRequest(asRequest({ host })).source).toBe('default');
    }
  });

  it('does not mistake the octets of a bare IP for a subdomain', () => {
    expect(realmFromRequest(asRequest({ host: '10.0.12.4' })).source).toBe('default');
  });

  it('honours x-client-slug outside production', () => {
    expect(realmFromRequest(asRequest({ host: 'localhost', 'x-client-slug': 'northwind' })))
      .toEqual({ slug: 'northwind', source: 'header' });
  });

  it('ignores x-client-slug in production — a header must not choose a workspace', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(realmFromRequest(asRequest({ host: 'localhost', 'x-client-slug': 'northwind' })).source)
        .toBe('default');
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('prefers a real subdomain over the header', () => {
    const realm = realmFromRequest(asRequest({
      host: 'northwind.vendorconnect.io',
      'x-client-slug': 'contoso',
    }));
    expect(realm).toEqual({ slug: 'northwind', source: 'subdomain' });
  });
});

describe('GET /api/auth/workspace', () => {
  it('tells a signed-out visitor whose workspace they are on', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' });

    const res = await request(app).get('/api/auth/workspace').set('x-client-slug', 'northwind');

    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({
      slug: 'northwind',
      companyName: 'Northwind Traders',
      features: { supplierSelfRegistration: true },
    });
  });

  it('carries the tenant branding the sign-in screen renders', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' });
    await withoutTenantScope(() => Client.updateOne(
      { clientId: 'CLT-0002' },
      { $set: { 'branding.primaryColor': '#2f6f4e', 'branding.logo': 'https://cdn.example.com/nw.svg' } },
    ));

    const res = await request(app).get('/api/auth/workspace').set('x-client-slug', 'northwind');

    expect(res.body.workspace.branding).toEqual({
      primaryColor: '#2f6f4e',
      logo: 'https://cdn.example.com/nw.svg',
    });
  });

  it('answers 404 for a hostname no tenant owns', async () => {
    const res = await request(app).get('/api/auth/workspace').set('x-client-slug', 'nobody');
    expect(res.status).toBe(404);
  });

  it('answers 404 for a suspended tenant, the same as for one that never existed', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await withoutTenantScope(() => Client.updateOne({ clientId: 'CLT-0002' }, { $set: { status: 'Suspended' } }));

    const res = await request(app).get('/api/auth/workspace').set('x-client-slug', 'northwind');
    expect(res.status).toBe(404);
  });

  it('never exposes SAP configuration or limits', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    const res = await request(app).get('/api/auth/workspace').set('x-client-slug', 'northwind');

    expect(res.body.workspace.sap).toBeUndefined();
    expect(res.body.workspace.limits).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/secret|password|credential/i);
  });
});

describe('registration is addressed to one workspace', () => {
  it('lands the supplier in the tenant whose subdomain they used', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });

    const res = await request(app)
      .post('/api/auth/register')
      .set('host', 'northwind.vendorconnect.io')
      .send(baseVendor);

    expect(res.status).toBe(201);
    expect(res.body.vendor.clientId).toBe('CLT-0002');
  });

  it('refuses a hostname no tenant owns', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('host', 'nobody.vendorconnect.io')
      .send(baseVendor);

    expect(res.status).toBe(400);
  });
});

describe('login is addressed to one workspace', () => {
  it('signs a supplier in on the subdomain of their own tenant', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });

    const res = await request(app)
      .post('/api/auth/login')
      .set('host', 'northwind.vendorconnect.io')
      .send({ vendorIdOrEmail: baseVendor.email, password: baseVendor.password });

    expect(res.status).toBe(200);
    expect(res.body.vendor.clientId).toBe('CLT-0002');
  });

  it('refuses the same credentials at the front door of another tenant', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'northwind' });
    await seedClient({ clientId: 'CLT-0003', slug: 'contoso' });
    await registerVendor(app, { clientId: 'CLT-0002' }, { clientSlug: 'northwind' });

    const res = await request(app)
      .post('/api/auth/login')
      .set('host', 'contoso.vendorconnect.io')
      .send({ vendorIdOrEmail: baseVendor.email, password: baseVendor.password });

    expect(res.status).toBe(401);
    // The wrong-tenant answer is the wrong-password answer: the door does not
    // report that this account exists somewhere else.
    expect(res.body.error).toBe('Invalid credentials');
  });
});
