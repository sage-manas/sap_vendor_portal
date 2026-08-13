// Phase 4: the SapAdapter contract, envelope-encrypted credentials, the driver
// factory and the platform screens that configure them.
const request = require('supertest');
const buildTestApp = require('./testApp');

const Client = require('../models/Client');
const SapConnection = require('../models/SapConnection');
const SapConnectionAudit = require('../models/SapConnectionAudit');
const SapLog = require('../models/SapLog');
const AuditLog = require('../models/AuditLog');

const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { encrypt, decrypt, generateDataKey, wrapDataKey, unwrapDataKey, encryptWithDataKey, decryptWithDataKey } = require('../utils/secretBox');
const { METHOD_NAMES, SAP_METHODS, DEFERRED_METHODS, assertImplements, notImplementedDriver } = require('../sap/contract');
const { DRIVERS, DRIVER_KEYS, driverCatalogue } = require('../sap/drivers');
const { SAP_TRANSACTIONS, transaction } = require('../config/sapTransactions');
const { createCircuitBreaker } = require('../sap/circuitBreaker');
const { getSapAdapterForClient, invalidateSapAdapter, buildTransientAdapter } = require('../sap');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { createOperatorSession, seedClient } = require('./helpers');
const { ROLES } = require('../config/roles');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// A deferred answer is scheduled on a zero-delay timer under test, so one turn
// of the event loop plus the awaits inside the handler is enough. This is the
// one place tests wait for the simulator.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => invalidateSapAdapter());

describe('the SapAdapter contract', () => {
  it('every declared method names a transaction that exists in the registry', () => {
    for (const [method, spec] of Object.entries(SAP_METHODS)) {
      if (!spec.transaction) continue;
      expect(() => transaction(spec.transaction)).not.toThrow();
    }
  });

  it('every registered transaction declares a type and a direction the SapLog accepts', () => {
    const types = SapLog.schema.path('type').enumValues;
    const directions = SapLog.schema.path('direction').enumValues;

    for (const entry of Object.values(SAP_TRANSACTIONS)) {
      expect(types).toContain(entry.type);
      expect(directions).toContain(entry.direction);
      expect(entry.label).toBeTruthy();
    }
  });

  it.each(DRIVER_KEYS)('the %s driver satisfies the whole contract', (key) => {
    const driver = DRIVERS[key].create({ clientId: 'CLT-0001', config: {}, secrets: {} });
    for (const method of METHOD_NAMES) {
      expect(typeof driver[method]).toBe('function');
    }
  });

  it('refuses to build a driver that is missing a method', () => {
    const incomplete = { ...notImplementedDriver('broken') };
    delete incomplete.invoiceCreate;

    expect(() => assertImplements(incomplete, 'broken')).toThrow(/missing invoiceCreate/);
  });

  it('the s4_odata and ecc_rfc skeletons throw not_implemented rather than pretending', async () => {
    for (const key of ['s4_odata', 'ecc_rfc']) {
      const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: key, config: {}, secrets: {} });

      await expect(runWithTenant('CLT-0001', () => adapter.rfqCreate({ rfq: { id: 'RFQ-1' } })))
        .rejects.toMatchObject({ code: 'not_implemented' });
    }
  });

  it('stamps every result with its source and freshness', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} });
    const result = await adapter.testConnection();

    expect(result.source).toBe('mock');
    expect(Date.parse(result.syncedAt)).not.toBeNaN();
  });

  it('declares exactly the deferred methods the drivers schedule', () => {
    expect(DEFERRED_METHODS.sort()).toEqual(['awaitGoodsReceipt', 'awaitPaymentRun', 'awaitVendorApproval']);
  });
});

describe('envelope encryption', () => {
  it('wraps a data key under the master key and round-trips a secret through it', () => {
    const dataKey = generateDataKey();
    const wrapped = wrapDataKey(dataKey);

    expect(wrapped.startsWith('v1:')).toBe(true);
    expect(wrapped).not.toContain(dataKey.toString('base64'));

    const sealed = encryptWithDataKey(dataKey, 'hunter2');
    expect(sealed.startsWith('v2:')).toBe(true);
    expect(sealed).not.toContain('hunter2');

    expect(decryptWithDataKey(unwrapDataKey(wrapped), sealed)).toBe('hunter2');
  });

  it('still reads v1 blobs, so Phase 3 MFA secrets keep working', () => {
    expect(decrypt(encrypt('JBSWY3DPEHPK3PXP'))).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a secret encrypted under a different data key', () => {
    const sealed = encryptWithDataKey(generateDataKey(), 'hunter2');
    expect(() => decryptWithDataKey(generateDataKey(), sealed)).toThrow();
  });

  it('a connection stores credentials encrypted and never serialises them', async () => {
    const connection = new SapConnection({ clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata' });
    connection.setSecrets({ username: 'RFCUSER', password: 'hunter2' });
    await withoutTenantScope(() => connection.save());

    const raw = await withoutTenantScope(() =>
      SapConnection.collection.findOne({ clientId: 'CLT-0001', environment: 'sandbox' }));

    expect(JSON.stringify(raw)).not.toContain('hunter2');
    expect(raw.secrets.password.startsWith('v2:')).toBe(true);

    // The obvious accident — res.json(connection) — cannot leak either half.
    const serialised = JSON.stringify(connection.toJSON());
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain(raw.wrappedDataKey);

    const reloaded = await withoutTenantScope(() =>
      SapConnection.findOne({ clientId: 'CLT-0001' }).select('+wrappedDataKey'));
    expect(reloaded.decryptSecrets()).toEqual({ username: 'RFCUSER', password: 'hunter2' });
    expect(reloaded.secretNames()).toEqual(['password', 'username']);
  });

  it('cannot decrypt a connection loaded without its wrapped key', async () => {
    const connection = new SapConnection({ clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata' });
    connection.setSecrets({ password: 'hunter2' });
    await withoutTenantScope(() => connection.save());

    const forDisplay = await withoutTenantScope(() => SapConnection.findOne({ clientId: 'CLT-0001' }));
    expect(forDisplay.decryptSecrets()).toEqual({});
  });

  it('clears a credential when it is set to empty, and leaves untouched ones alone', async () => {
    const connection = new SapConnection({ clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata' });
    connection.setSecrets({ username: 'RFCUSER', password: 'hunter2' });
    connection.setSecrets({ password: '' });

    expect(connection.secretNames()).toEqual(['username']);
  });
});

describe('the circuit breaker', () => {
  const failing = () => Promise.reject(new Error('gateway down'));

  it('opens after the threshold and then refuses without calling through', async () => {
    const breaker = createCircuitBreaker({ label: 'test', failureThreshold: 3, resetAfterMs: 10_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(breaker.run(failing)).rejects.toThrow('gateway down');
    }

    expect(breaker.state).toBe('open');

    const call = jest.fn();
    await expect(breaker.run(call)).rejects.toMatchObject({ code: 'sap_circuit_open' });
    expect(call).not.toHaveBeenCalled();
  });

  it('half-opens after the cooldown, and one success closes it', async () => {
    const breaker = createCircuitBreaker({ label: 'test', failureThreshold: 1, resetAfterMs: 0 });

    await expect(breaker.run(failing)).rejects.toThrow();
    expect(breaker.state).toBe('half-open');

    await expect(breaker.run(async () => 'ok')).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(breaker.snapshot().failures).toBe(0);
  });

  it('re-opens immediately when the half-open probe fails', async () => {
    const breaker = createCircuitBreaker({ label: 'test', failureThreshold: 1, resetAfterMs: 20 });

    await expect(breaker.run(failing)).rejects.toThrow();
    expect(breaker.state).toBe('open');

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(breaker.state).toBe('half-open');

    // The probe fails, and the cooldown starts again from now — one failure
    // against a threshold of one is enough because the system has just said it
    // is still down.
    await expect(breaker.run(failing)).rejects.toThrow();
    expect(breaker.state).toBe('open');
  });
});

describe('getSapAdapterForClient', () => {
  it('gives an unconfigured tenant the mock driver rather than failing', async () => {
    const adapter = await getSapAdapterForClient('CLT-0001');
    expect(adapter.driver).toBe('mock');
    expect(adapter.environment).toBe('sandbox');
  });

  it('caches per client and re-reads after a configuration change', async () => {
    const first = await getSapAdapterForClient('CLT-0001');
    expect(await getSapAdapterForClient('CLT-0001')).toBe(first);

    await withoutTenantScope(() => SapConnection.create({
      clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata', config: { baseUrl: 'https://s4.example.com', sapClient: '100' },
    }));

    const second = await getSapAdapterForClient('CLT-0001');
    expect(second).not.toBe(first);
    expect(second.driver).toBe('s4_odata');
  });

  it('follows the tenant onto production once it has been promoted', async () => {
    await withoutTenantScope(async () => {
      await SapConnection.create({ clientId: 'CLT-0001', environment: 'sandbox', driver: 'mock' });
      await SapConnection.create({ clientId: 'CLT-0001', environment: 'production', driver: 'ecc_rfc', config: { ashost: 'sap.example.com', sysnr: '00', sapClient: '100' } });
      await Client.updateOne({ clientId: 'CLT-0001' }, { sapEnvironment: 'production' });
    });

    const adapter = await getSapAdapterForClient('CLT-0001');
    expect(adapter.driver).toBe('ecc_rfc');
    expect(adapter.environment).toBe('production');
  });

  it('never hands two tenants the same adapter', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'rival', companyName: 'Rival' });

    const a = await getSapAdapterForClient('CLT-0001');
    const b = await getSapAdapterForClient('CLT-0002');

    expect(a.clientId).toBe('CLT-0001');
    expect(b.clientId).toBe('CLT-0002');
    expect(a).not.toBe(b);
  });

  it('refuses to build an adapter with no tenant', async () => {
    await expect(getSapAdapterForClient(null)).rejects.toThrow(/requires a clientId/);
  });
});

describe('the mock driver', () => {
  it('logs a call under the transaction registry’s own code and direction', async () => {
    const adapter = await getSapAdapterForClient('CLT-0001');

    await runWithTenant('CLT-0001', () => adapter.poAcknowledge({
      po: { id: 'PO-2026-0001', vendorId: 'vendor_1', acknowledgedAt: new Date() },
    }));

    const entry = await runWithTenant('CLT-0001', () => SapLog.findOne({ documentRef: 'PO-2026-0001' }));
    expect(entry).toMatchObject({
      name: SAP_TRANSACTIONS.PO_ACKNOWLEDGE.code,
      type: SAP_TRANSACTIONS.PO_ACKNOWLEDGE.type,
      direction: SAP_TRANSACTIONS.PO_ACKNOWLEDGE.direction,
      status: 'SUCCESS',
      clientId: 'CLT-0001',
    });
  });

  it('takes its timings from configuration rather than a literal in a controller', async () => {
    const fast = buildTransientAdapter({
      clientId: 'CLT-0001', driver: 'mock', secrets: {},
      config: { timings: { goodsReceiptMs: 0 } },
    });

    const handler = jest.fn(async (receipt) => ({ id: receipt.grnId, items: receipt.items, sapMigoDoc: receipt.sapMigoDoc }));
    fast.awaitGoodsReceipt({ asn: { id: 'ASN-1', vendorId: 'vendor_1', items: [{ line: 10, shippedQuantity: 100, materialCode: 'MAT-1', description: 'x', uom: 'EA' }] }, po: { id: 'PO-1' }, vendorId: 'vendor_1' }, handler);

    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    const [receipt] = handler.mock.calls[0];
    // 95% accepted by default — the rejected remainder is what exercises the
    // three-way match downstream.
    expect(receipt.items[0]).toMatchObject({ receivedQuantity: 100, acceptedQuantity: 95, rejectedQuantity: 5 });
    expect(receipt.source).toBe('mock');
  });

  it('honours a driver behaviour override', async () => {
    const strict = buildTransientAdapter({
      clientId: 'CLT-0001', driver: 'mock', secrets: {},
      config: { timings: { goodsReceiptMs: 0 }, behaviour: { grnAcceptanceRate: 1 } },
    });

    const handler = jest.fn(async (receipt) => ({ id: receipt.grnId }));
    strict.awaitGoodsReceipt({ asn: { id: 'ASN-1', vendorId: 'v', items: [{ line: 10, shippedQuantity: 100 }] }, po: { id: 'PO-1' }, vendorId: 'v' }, handler);

    await settle();
    expect(handler.mock.calls[0][0].items[0].rejectedQuantity).toBe(0);
  });

  it('writes no log and resolves nothing when the handler declines the answer', async () => {
    const adapter = await getSapAdapterForClient('CLT-0001');

    adapter.awaitGoodsReceipt(
      { asn: { id: 'ASN-1', vendorId: 'v', items: [{ line: 10, shippedQuantity: 10 }] }, po: { id: 'PO-1' }, vendorId: 'v' },
      async () => null,
    );

    await settle();
    const logs = await runWithTenant('CLT-0001', () => SapLog.countDocuments({}));
    expect(logs).toBe(0);
  });

  it('binds the tenant around a deferred answer without the caller doing it', async () => {
    const adapter = await getSapAdapterForClient('CLT-0001');
    let boundInsideHandler = null;

    adapter.awaitPaymentRun(
      { invoice: { id: 'INV-1', vendorId: 'v', totalAmount: 1000 }, vendorId: 'v' },
      async () => {
        // A query here would throw if the tenant were not bound.
        boundInsideHandler = await SapLog.countDocuments({});
        return { id: 'PMT-1' };
      },
    );

    await settle();
    expect(boundInsideHandler).toBe(0);

    const entry = await runWithTenant('CLT-0001', () => SapLog.findOne({ documentRef: 'PMT-1' }));
    expect(entry.name).toBe(SAP_TRANSACTIONS.PAYMENT_RUN.code);
  });

  it('records a failed call rather than losing it', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 's4_odata', config: {}, secrets: {} });

    await expect(runWithTenant('CLT-0001', () => adapter.invoiceCreate({ invoice: { id: 'INV-9' }, vendorId: 'v' })))
      .rejects.toMatchObject({ code: 'not_implemented' });

    const entry = await runWithTenant('CLT-0001', () => SapLog.findOne({ name: SAP_TRANSACTIONS.INVOICE_CREATE.code }));
    expect(entry.status).toBe('FAILED');
    expect(entry.errorMessage).toMatch(/not_implemented/);
  });
});

describe('platform SAP configuration', () => {
  const configure = (token, environment, body) =>
    request(app).put(`/api/platform/tenants/CLT-0001/sap/${environment}`).set(bearer(token)).send(body);

  const s4Body = (overrides = {}) => ({
    driver: 's4_odata',
    config: { baseUrl: 'https://s4.example.com', sapClient: '100' },
    secrets: { username: 'RFCUSER', password: 'hunter2' },
    ...overrides,
  });

  it('returns the driver catalogue and both environments', async () => {
    const { token } = await createOperatorSession();

    const res = await request(app).get('/api/platform/tenants/CLT-0001/sap').set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.activeEnvironment).toBe('sandbox');
    expect(res.body.drivers.map((entry) => entry.key).sort()).toEqual([...DRIVER_KEYS].sort());
    expect(res.body.connections.map((entry) => entry.environment)).toEqual(['sandbox', 'production']);
    expect(res.body.connections.every((entry) => entry.connection === null)).toBe(true);
  });

  it('the catalogue carries field names but no values', () => {
    const serialised = JSON.stringify(driverCatalogue());
    expect(serialised).toContain('password');
    expect(serialised).not.toContain('create');
    expect(serialised).not.toContain('validateConfig');
  });

  it('stores a connection, and never returns the credentials', async () => {
    const { token } = await createOperatorSession();

    const res = await configure(token, 'sandbox', s4Body());

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.connection.configuredSecrets).toEqual(['password', 'username']);
    expect(res.body.connection.config).toEqual({ baseUrl: 'https://s4.example.com', sapClient: '100' });

    const reread = await request(app).get('/api/platform/tenants/CLT-0001/sap').set(bearer(token));
    expect(JSON.stringify(reread.body)).not.toContain('hunter2');
  });

  it('refuses a configuration the driver considers incomplete', async () => {
    const { token } = await createOperatorSession();

    const res = await configure(token, 'sandbox', s4Body({ config: { sapClient: '100' } }));

    expect(res.status).toBe(400);
    expect(res.body.errors.baseUrl).toMatch(/required/i);
  });

  it('refuses a credential the driver does not have', async () => {
    const { token } = await createOperatorSession();

    const res = await configure(token, 'sandbox', s4Body({ secrets: { apiKey: 'x' } }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no credential named apiKey/);
  });

  it('refuses an unknown driver and an unknown environment', async () => {
    const { token } = await createOperatorSession();

    expect((await configure(token, 'sandbox', s4Body({ driver: 'hana_dreams' }))).status).toBe(400);
    expect((await configure(token, 'staging', s4Body())).status).toBe(400);
  });

  it('drops the previous test result when the configuration changes', async () => {
    const { token } = await createOperatorSession();

    await configure(token, 'sandbox', { driver: 'mock', config: {}, secrets: {} });
    const tested = await request(app).post('/api/platform/tenants/CLT-0001/sap/sandbox/test').set(bearer(token));
    expect(tested.body.result.ok).toBe(true);

    const changed = await configure(token, 'sandbox', { driver: 'mock', config: { timings: { goodsReceiptMs: 0 } }, secrets: {} });
    expect(changed.body.connection.lastTest).toBeNull();
  });

  it('tests a connection and records the outcome on both trails', async () => {
    const { token, operator } = await createOperatorSession();
    await configure(token, 'sandbox', { driver: 'mock', config: {}, secrets: {} });

    const res = await request(app).post('/api/platform/tenants/CLT-0001/sap/sandbox/test').set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ ok: true, driver: 'mock', testedBy: operator.email });

    const trail = await withoutTenantScope(() => SapConnectionAudit.findOne({ action: AUDIT_ACTIONS.SAP_CONNECTION_TESTED }));
    expect(trail).toMatchObject({ clientId: 'CLT-0001', environment: 'sandbox', actorEmail: operator.email });
    expect(trail.result.ok).toBe(true);

    const audit = await withoutTenantScope(() => AuditLog.findOne({ action: AUDIT_ACTIONS.SAP_CONNECTION_TESTED }));
    expect(audit.clientId).toBe('CLT-0001');
  });

  it('records field-level changes and credential names, but never a credential', async () => {
    const { token } = await createOperatorSession();

    await configure(token, 'sandbox', s4Body());
    await configure(token, 'sandbox', s4Body({ config: { baseUrl: 'https://s4-new.example.com', sapClient: '200' }, secrets: { password: 'newpass' } }));

    const entries = await withoutTenantScope(() => SapConnectionAudit.find({ clientId: 'CLT-0001' }).sort({ at: 1 }));

    expect(entries.map((entry) => entry.action)).toEqual([
      AUDIT_ACTIONS.SAP_CONNECTION_CREATED,
      AUDIT_ACTIONS.SAP_CONNECTION_UPDATED,
    ]);
    expect(entries[1].changes.baseUrl).toMatchObject({ from: 'https://s4.example.com', to: 'https://s4-new.example.com' });
    expect(entries[1].secretsChanged).toEqual(['password']);
    expect(JSON.stringify(entries)).not.toContain('newpass');
    expect(JSON.stringify(entries)).not.toContain('hunter2');
  });

  it('keeps the connection trail append-only', async () => {
    const { token } = await createOperatorSession();
    await configure(token, 'sandbox', { driver: 'mock', config: {}, secrets: {} });

    const entry = await withoutTenantScope(() => SapConnectionAudit.findOne({ clientId: 'CLT-0001' }));
    entry.actorEmail = 'someone.else@example.com';

    await expect(withoutTenantScope(() => entry.save())).rejects.toThrow(/append-only/);
    await expect(withoutTenantScope(() => SapConnectionAudit.deleteMany({}))).rejects.toThrow(/append-only/);
  });
});

describe('promotion to production', () => {
  const promote = (token, environment, reason = 'go live') =>
    request(app).post('/api/platform/tenants/CLT-0001/sap/promote').set(bearer(token)).send({ environment, reason });

  it('refuses to promote onto an environment that has no connection', async () => {
    const { token } = await createOperatorSession();

    const res = await promote(token, 'production');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No production connection/);
  });

  it('refuses to promote onto a connection that has not passed a test', async () => {
    const { token } = await createOperatorSession();
    await request(app).put('/api/platform/tenants/CLT-0001/sap/production').set(bearer(token))
      .send({ driver: 'mock', config: {}, secrets: {} });

    const res = await promote(token, 'production');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Test the production connection/);

    const client = await withoutTenantScope(() => Client.findOne({ clientId: 'CLT-0001' }));
    expect(client.sapEnvironment).toBe('sandbox');
  });

  it('promotes once the test passes, and the tenant’s traffic follows', async () => {
    const { token, operator } = await createOperatorSession();
    await request(app).put('/api/platform/tenants/CLT-0001/sap/production').set(bearer(token))
      .send({ driver: 'mock', config: { timings: { paymentRunMs: 1 } }, secrets: {} });
    await request(app).post('/api/platform/tenants/CLT-0001/sap/production/test').set(bearer(token));

    const res = await promote(token, 'production');

    expect(res.status).toBe(200);
    expect(res.body.activeEnvironment).toBe('production');

    const adapter = await getSapAdapterForClient('CLT-0001');
    expect(adapter.environment).toBe('production');

    const trail = await withoutTenantScope(() => SapConnectionAudit.findOne({ action: AUDIT_ACTIONS.SAP_CONNECTION_PROMOTED }));
    expect(trail.changes.activeEnvironment).toMatchObject({ from: 'sandbox', to: 'production' });
    expect(trail.actorEmail).toBe(operator.email);
  });

  it('lets a tenant be rolled back to sandbox without qualifying for it', async () => {
    const { token } = await createOperatorSession();
    await withoutTenantScope(async () => {
      await SapConnection.create({ clientId: 'CLT-0001', environment: 'sandbox', driver: 'mock' });
      await Client.updateOne({ clientId: 'CLT-0001' }, { sapEnvironment: 'production' });
    });

    const res = await promote(token, 'sandbox', 'incident rollback');
    expect(res.status).toBe(200);
    expect(res.body.activeEnvironment).toBe('sandbox');
  });

  it('refuses to promote onto the environment the tenant is already on', async () => {
    const { token } = await createOperatorSession();
    const res = await promote(token, 'sandbox');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already running/);
  });
});

describe('who may configure SAP', () => {
  it('an sap_manager may configure, and never sees tenant business data', async () => {
    const { token } = await createOperatorSession({ role: ROLES.SAP_MANAGER });

    expect((await request(app).get('/api/platform/tenants/CLT-0001/sap').set(bearer(token))).status).toBe(200);
    // tenant:manage is not theirs — the export is the console's only route to a
    // tenant's documents, and it stays shut.
    expect((await request(app).get('/api/platform/tenants/CLT-0001/export').set(bearer(token))).status).toBe(403);
  });

  it('a tenant administrator cannot reach the SAP screens at all', async () => {
    const { createTenantUser } = require('./helpers');
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app).get('/api/platform/tenants/CLT-0001/sap').set(bearer(token));
    // 404, not 403: a tenant account must not learn the console exists.
    expect(res.status).toBe(404);
  });

  it('answers 404 for a tenant that does not exist, rather than confirming it', async () => {
    const { token } = await createOperatorSession();

    const res = await request(app).get('/api/platform/tenants/CLT-9999/sap').set(bearer(token));
    expect(res.status).toBe(404);
  });
});

describe('one tenant’s SAP configuration is invisible to another', () => {
  beforeEach(() => seedClient({ clientId: 'CLT-0002', slug: 'rival', companyName: 'Rival Manufacturing' }));

  it('keeps connections, adapters and change history apart', async () => {
    const { token } = await createOperatorSession();

    await request(app).put('/api/platform/tenants/CLT-0001/sap/sandbox').set(bearer(token))
      .send({ driver: 'mock', config: { timings: { paymentRunMs: 1 } }, secrets: {} });
    await request(app).put('/api/platform/tenants/CLT-0002/sap/sandbox').set(bearer(token))
      .send({ driver: 's4_odata', config: { baseUrl: 'https://rival.example.com', sapClient: '900' }, secrets: { password: 'rival-secret' } });

    const first = await request(app).get('/api/platform/tenants/CLT-0001/sap').set(bearer(token));
    expect(JSON.stringify(first.body)).not.toContain('rival.example.com');
    expect(JSON.stringify(first.body)).not.toContain('rival-secret');

    expect((await getSapAdapterForClient('CLT-0001')).driver).toBe('mock');
    expect((await getSapAdapterForClient('CLT-0002')).driver).toBe('s4_odata');

    const trail = await request(app).get('/api/platform/tenants/CLT-0001/sap/audit').set(bearer(token));
    expect(trail.body.entries).toHaveLength(1);
    expect(trail.body.entries.every((entry) => entry.clientId === 'CLT-0001')).toBe(true);
  });

  it('keeps each tenant’s SAP log to itself', async () => {
    const a = await getSapAdapterForClient('CLT-0001');
    const b = await getSapAdapterForClient('CLT-0002');

    await runWithTenant('CLT-0001', () => a.poAcknowledge({ po: { id: 'PO-A', vendorId: 'v', acknowledgedAt: new Date() } }));
    await runWithTenant('CLT-0002', () => b.poAcknowledge({ po: { id: 'PO-B', vendorId: 'v', acknowledgedAt: new Date() } }));

    const seenByA = await runWithTenant('CLT-0001', () => SapLog.find({}));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].documentRef).toBe('PO-A');
  });
});
