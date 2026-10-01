const express = require('express');
const request = require('supertest');
const buildTestApp = require('./testApp');
const { realmFromRequest } = require('../utils/resolveClient');
const { seedClient, baseVendor, confirmationTokenFor } = require('./helpers');

const app = buildTestApp();

// Per-client subdomains (decision 0.1): acme.portal.example.com is Acme's
// workspace. Before, the first label of *any* three-part host was a slug, so at
// a shared name like vendorportal.sagetl.com ("vendorportal") every login
// failed as "Invalid credentials", and any client-supplied X-Forwarded-Host was
// believed. The base domain is now configuration, and only hosts under it name
// a workspace.

const BASE = 'portal.example.com';
const withEnv = async (vars, fn) => {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
};
const realmOf = (host) => withEnv({ PORTAL_BASE_DOMAIN: BASE, NODE_ENV: 'production' }, () => realmFromRequest({ headers: { host } }));

describe('realm resolution under PORTAL_BASE_DOMAIN', () => {
  it('reads the workspace from one label under the base domain', async () => {
    expect(await realmOf(`acme.${BASE}`)).toEqual({ slug: 'acme', source: 'subdomain' });
    expect(await realmOf(`Acme.${BASE}:443`)).toEqual({ slug: 'acme', source: 'subdomain' });
  });

  it('names no workspace at the bare base domain or on the reserved hostnames', async () => {
    expect((await realmOf(BASE)).slug).toBeNull();
    for (const label of ['www', 'platform', 'app', 'api', 'admin']) {
      expect((await realmOf(`${label}.${BASE}`)).slug).toBeNull();
    }
  });

  it('names no workspace for a host outside the base domain, however much it looks like one', async () => {
    for (const host of [`acme.evil.example`, `acme.${BASE}.evil.example`, `a.b.${BASE}`, `acme${BASE}`, 'vendorportal.sagetl.com', '10.0.0.4']) {
      expect({ host, realm: await realmOf(host) }).toEqual({ host, realm: { slug: null, source: 'unknown_host' } });
    }
  });

  it('a shared-domain name is not read as a tenant slug', async () => {
    // What made every login fail on vendorportal.sagetl.com.
    expect((await withEnv({ PORTAL_BASE_DOMAIN: 'sagetl.com', NODE_ENV: 'production' }, () =>
      realmFromRequest({ headers: { host: 'vendorportal.sagetl.com' } }))).slug).toBe('vendorportal');
    // With the base set to the portal's own name, that host is the apex.
    expect((await withEnv({ PORTAL_BASE_DOMAIN: 'vendorportal.sagetl.com', NODE_ENV: 'production' }, () =>
      realmFromRequest({ headers: { host: 'vendorportal.sagetl.com' } }))).slug).toBeNull();
  });

  it('does not let x-client-slug choose a workspace in production', async () => {
    const realm = await withEnv({ PORTAL_BASE_DOMAIN: BASE, NODE_ENV: 'production' }, () =>
      realmFromRequest({ headers: { host: BASE, 'x-client-slug': 'acme' } }));
    expect(realm.slug).toBeNull();
  });

  it('keeps localhost usable for development when a base domain is set', async () => {
    const realm = await withEnv({ PORTAL_BASE_DOMAIN: BASE, NODE_ENV: 'development' }, () =>
      realmFromRequest({ headers: { host: 'localhost:3000', 'x-client-slug': 'acme' } }));
    expect(realm).toEqual({ slug: 'acme', source: 'header' });
  });
});

describe('X-Forwarded-Host is only believed from a trusted proxy', () => {
  const echoRealm = (trustProxy) => {
    const probe = express();
    probe.set('trust proxy', trustProxy);
    probe.get('/realm', (req, res) => res.json(realmFromRequest(req)));
    return probe;
  };
  const ask = (probe) => withEnv({ PORTAL_BASE_DOMAIN: BASE, NODE_ENV: 'production' }, () =>
    request(probe).get('/realm').set('Host', BASE).set('X-Forwarded-Host', `acme.${BASE}`));

  it('ignores it when the caller is not a trusted proxy', async () => {
    const res = await ask(echoRealm(false));
    expect(res.body.slug).toBeNull();
  });

  it('follows it from the local nginx that overwrites it', async () => {
    const res = await ask(echoRealm('loopback'));
    expect(res.body).toEqual({ slug: 'acme', source: 'subdomain' });
  });
});

describe('sign-in through production-shaped hostnames', () => {
  const at = (host) => (req) => req.set('Host', host);
  // Registration's confirmation mail is sent after the response, and production
  // would pick the SMTP transport: keep it in memory so the test can read it.
  const prod = (fn) => withEnv({ PORTAL_BASE_DOMAIN: BASE, NODE_ENV: 'production', MAIL_TRANSPORT: 'memory' }, fn);
  const payload = { ...baseVendor, email: 'acme-supplier@example.com', vendorId: 'vendor_acme_1', gstin: '27AABCA1234F1Z5', pan: 'AABCA1234F' };

  beforeEach(() => seedClient({ clientId: 'CLT-0002', slug: 'acme', companyName: 'Acme Ltd' }));

  it('registers and logs in at the tenant subdomain', async () => {
    const registered = await prod(() => at(`acme.${BASE}`)(request(app).post('/api/auth/register')).send(payload));
    expect(registered.status).toBe(202);

    const confirmed = await prod(async () => at(`acme.${BASE}`)(request(app).post('/api/auth/confirm-email'))
      .send({ token: await confirmationTokenFor(payload.email), password: payload.password }));
    expect(confirmed.status).toBe(200);

    const login = await prod(() => at(`acme.${BASE}`)(request(app).post('/api/auth/login'))
      .send({ vendorIdOrEmail: payload.email, password: payload.password }));
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });

  it('an unknown subdomain is a 404 for the workspace, registration and login', async () => {
    const workspace = await prod(() => at(`nobody.${BASE}`)(request(app).get('/api/auth/workspace')));
    const register = await prod(() => at(`nobody.${BASE}`)(request(app).post('/api/auth/register')).send(payload));
    const login = await prod(() => at(`nobody.${BASE}`)(request(app).post('/api/auth/login'))
      .send({ vendorIdOrEmail: payload.email, password: payload.password }));

    expect([workspace.status, register.status, login.status]).toEqual([404, 404, 404]);
  });

  it('the bare base domain names no workspace', async () => {
    const workspace = await prod(() => at(BASE)(request(app).get('/api/auth/workspace')));
    expect(workspace.status).toBe(404);
  });

  it('an account cannot sign in on another tenant\'s subdomain', async () => {
    await seedClient({ clientId: 'CLT-0003', slug: 'globex', companyName: 'Globex' });
    await prod(() => at(`acme.${BASE}`)(request(app).post('/api/auth/register')).send(payload));

    const login = await prod(() => at(`globex.${BASE}`)(request(app).post('/api/auth/login'))
      .send({ vendorIdOrEmail: payload.email, password: payload.password }));
    expect(login.status).toBe(401);
  });
});

describe('boot configuration', () => {
  const validateEnv = require('../config/validateEnv');

  it('refuses to start in production without PORTAL_BASE_DOMAIN', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      expect(() => withEnvSync({
        NODE_ENV: 'production', PORT: '5000', DATABASE_URL: 'x', FRONTEND_URL: 'https://a.example', JWT_SECRET: 'x'.repeat(40), MASTER_KEY: 'k', PORTAL_BASE_DOMAIN: '',
      }, validateEnv)).toThrow('exit');
    } finally {
      exit.mockRestore();
    }
  });
});

function withEnvSync(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    Object.entries(previous).forEach(([key, value]) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
}
