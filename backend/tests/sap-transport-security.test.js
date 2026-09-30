const request = require('supertest');
const buildTestApp = require('./testApp');
const { validateConfig, configWarnings } = require('../sap/drivers/s4odata.driver');
const { createOperatorSession, seedClient } = require('./helpers');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// A production SAP connection carries the technical user's password and every
// vendor's bank details. Over plain http both cross the network readable, and
// nothing on the way can tell the portal it is talking to the real system.
// TLS and authentication on SAP's own Z endpoints are the customer's SAP team's
// to provide (docs/abap-requests/z-endpoint-authentication-disclosure.md); what
// the portal controls is refusing to be configured against http in production.

const base = { sapClient: '100', companyCode: '1000' };
const production = { environment: 'production', secrets: { username: 'RFCUSER', password: 'x' } };

describe('s4_odata validateConfig — transport security', () => {
  it('refuses an http:// base URL for production', () => {
    const errors = validateConfig({ ...base, baseUrl: 'http://s4.example.com' }, production);
    expect(errors.baseUrl).toMatch(/https/i);
  });

  it('is not fooled by scheme case or leading whitespace', () => {
    expect(validateConfig({ ...base, baseUrl: 'HTTP://s4.example.com' }, production).baseUrl).toBeTruthy();
    expect(validateConfig({ ...base, baseUrl: ' http://s4.example.com' }, production).baseUrl).toBeTruthy();
  });

  it('accepts https:// for production', () => {
    expect(validateConfig({ ...base, baseUrl: 'https://s4.example.com' }, production)).toEqual({});
  });

  it('still refuses production with no credentials (issue #79)', () => {
    const errors = validateConfig({ ...base, baseUrl: 'https://s4.example.com' }, { environment: 'production', secrets: {} });
    expect(errors.credentials).toBeTruthy();
  });

  it('allows http:// for a sandbox, and says so as a warning rather than an error', () => {
    const config = { ...base, baseUrl: 'http://sandbox.example.com' };
    expect(validateConfig(config, { environment: 'sandbox', secrets: {} })).toEqual({});
    expect(configWarnings(config, { environment: 'sandbox' })).toEqual([expect.stringMatching(/http/i)]);
  });

  it('has no warning for https', () => {
    expect(configWarnings({ ...base, baseUrl: 'https://s4.example.com' }, { environment: 'sandbox' })).toEqual([]);
  });
});

describe('PUT /api/platform/tenants/:clientId/sap/:environment', () => {
  const put = (token, environment, body) =>
    request(app).put(`/api/platform/tenants/CLT-0001/sap/${environment}`).set(bearer(token)).send({ driver: 's4_odata', ...body });

  beforeEach(() => seedClient());

  it('refuses to save a production connection over http', async () => {
    const { token } = await createOperatorSession();
    const res = await put(token, 'production', {
      config: { ...base, baseUrl: 'http://s4.example.com' },
      secrets: { username: 'RFCUSER', password: 'x' },
    });

    expect(res.status).toBe(400);
    expect(res.body.errors.baseUrl).toMatch(/https/i);
  });

  it('saves a sandbox over http and returns the warning to the console', async () => {
    const { token } = await createOperatorSession();
    const res = await put(token, 'sandbox', { config: { ...base, baseUrl: 'http://sandbox.example.com' }, secrets: {} });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([expect.stringMatching(/http/i)]);
  });

  it('returns no warnings for an https sandbox', async () => {
    const { token } = await createOperatorSession();
    const res = await put(token, 'sandbox', { config: { ...base, baseUrl: 'https://sandbox.example.com' }, secrets: {} });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([]);
  });
});
