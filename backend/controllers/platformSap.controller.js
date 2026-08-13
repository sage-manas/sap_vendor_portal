const Client = require('../models/Client');
const SapConnection = require('../models/SapConnection');
const SapConnectionAudit = require('../models/SapConnectionAudit');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const { withoutTenantScope } = require('../utils/tenantContext');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { driverDefinition, driverCatalogue, DEFAULT_DRIVER } = require('../sap/drivers');
const { buildTransientAdapter, invalidateSapAdapter } = require('../sap');

// SAP configuration, per tenant, from the platform console.
//
// This is `sap:configure` territory: both platform roles hold it, and it is the
// one thing an sap_manager can change. Note what is *not* here — no endpoint
// returns a credential, and no endpoint reads a tenant's RFQs, POs or invoices.
// An operator configures the pipe; what flows through it stays the tenant's.

const ENVIRONMENTS = SapConnection.ENVIRONMENTS;

const assertEnvironment = (environment) => {
  if (!ENVIRONMENTS.includes(environment)) {
    throw ApiError.badRequest(`Unknown environment "${environment}" — expected ${ENVIRONMENTS.join(' or ')}`);
  }
  return environment;
};

const findClientOr404 = async (clientId) => {
  const client = await withoutTenantScope(() => Client.findOne({ clientId }));
  if (!client) throw ApiError.notFound('Not found');
  return client;
};

// What the console sees. `secrets` becomes a list of names — enough to render
// "password: configured", never enough to learn one.
const formatConnection = (connection, { active }) => {
  if (!connection) return null;

  return {
    clientId: connection.clientId,
    environment: connection.environment,
    driver: connection.driver,
    config: connection.config || {},
    configuredSecrets: connection.secretNames(),
    lastTest: connection.lastTest || null,
    promotedAt: connection.promotedAt || null,
    promotedBy: connection.promotedBy || null,
    updatedAt: connection.updatedAt,
    updatedBy: connection.updatedBy || null,
    // Whether this is the connection the tenant's traffic actually uses.
    active,
  };
};

const actorFor = (req) => ({
  actorId: req.auth?.id,
  actorEmail: req.auth?.email,
  actorRole: req.auth?.role,
  ip: req.ip,
});

// The second, finer-grained trail (see SapConnectionAudit). AuditLog says a
// connection changed; this says which fields, and — for secrets — only which
// names, never a value.
const recordConnectionAudit = async ({ req, clientId, environment, action, driver, changes, secretsChanged, result }) => {
  try {
    await SapConnectionAudit.create({
      clientId, environment, action, driver,
      changes: changes || {},
      secretsChanged: secretsChanged || [],
      result,
      ...actorFor(req),
    });
  } catch (error) {
    logger.error(`[sap] failed to write SapConnectionAudit for ${clientId}/${environment}: ${error.message}`);
  }
};

// Field-level diff of the non-secret config, so the trail answers "what changed"
// rather than "something changed".
const diffConfig = (before = {}, after = {}) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = {};

  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from: from ?? null, to: to ?? null };
  }
  return changes;
};

// @desc    A tenant's SAP configuration, both environments
// @route   GET /api/platform/tenants/:clientId/sap
// @access  sap:configure
const getSapConfiguration = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);

  const connections = await withoutTenantScope(() =>
    SapConnection.find({ clientId: client.clientId }));

  const byEnvironment = Object.fromEntries(connections.map((entry) => [entry.environment, entry]));

  res.json({
    success: true,
    clientId: client.clientId,
    companyName: client.companyName,
    activeEnvironment: client.sapEnvironment || 'sandbox',
    // The console renders a form per driver from this, which is why there is
    // one SAP screen rather than one per driver.
    drivers: driverCatalogue(),
    connections: ENVIRONMENTS.map((environment) => ({
      environment,
      connection: formatConnection(byEnvironment[environment], {
        active: (client.sapEnvironment || 'sandbox') === environment,
      }),
    })),
  });
});

// @desc    Create or update one environment's connection
// @route   PUT /api/platform/tenants/:clientId/sap/:environment
// @access  sap:configure
const configureSap = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);
  const environment = assertEnvironment(req.params.environment);
  const { driver = DEFAULT_DRIVER, config = {}, secrets = {} } = req.body;

  const definition = driverDefinition(driver);

  const errors = definition.validateConfig(config);
  if (Object.keys(errors).length) {
    throw ApiError.badRequest('The connection details are incomplete', { errors });
  }

  const unknownSecrets = Object.keys(secrets)
    .filter((name) => !definition.secretFields.some((field) => field.name === name));
  if (unknownSecrets.length) {
    throw ApiError.badRequest(`The ${definition.label} driver has no credential named ${unknownSecrets.join(', ')}`);
  }

  const existing = await withoutTenantScope(() =>
    SapConnection.findOne({ clientId: client.clientId, environment }).select('+wrappedDataKey'));

  const isNew = !existing;
  const connection = existing || new SapConnection({ clientId: client.clientId, environment, createdBy: req.auth?.email });

  const before = { driver: connection.driver, ...(connection.config || {}) };

  connection.driver = driver;
  connection.config = config;
  connection.updatedBy = req.auth?.email;
  // A configuration change invalidates any previous proof that it worked. An
  // operator seeing a green tick against settings they have since edited is
  // exactly the kind of false comfort this phase exists to remove.
  connection.lastTest = null;
  connection.setSecrets(secrets);

  await connection.save();
  invalidateSapAdapter(client.clientId);

  const changes = diffConfig(before, { driver, ...config });
  const secretsChanged = Object.keys(secrets);
  const action = isNew ? AUDIT_ACTIONS.SAP_CONNECTION_CREATED : AUDIT_ACTIONS.SAP_CONNECTION_UPDATED;

  await recordConnectionAudit({ req, clientId: client.clientId, environment, action, driver, changes, secretsChanged });
  await recordAudit({
    action,
    req,
    clientId: client.clientId,
    target: { type: 'SapConnection', id: String(connection._id), label: `${client.clientId}/${environment}` },
    // Secret *names* only. recordAudit would redact a value anyway, but the
    // rule is that one never gets this far.
    meta: { driver, environment, changedFields: Object.keys(changes), credentialsSet: secretsChanged },
  });

  res.json({
    success: true,
    connection: formatConnection(connection, { active: (client.sapEnvironment || 'sandbox') === environment }),
  });
});

// @desc    Test one environment's connection
// @route   POST /api/platform/tenants/:clientId/sap/:environment/test
// @access  sap:configure
const testSapConnection = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);
  const environment = assertEnvironment(req.params.environment);

  const connection = await withoutTenantScope(() =>
    SapConnection.findOne({ clientId: client.clientId, environment }).select('+wrappedDataKey'));

  if (!connection) throw ApiError.badRequest(`No ${environment} connection is configured for this tenant`);

  // A transient adapter, so a test never disturbs the cached one the tenant's
  // live traffic is running on, and never trips its circuit breaker.
  const adapter = buildTransientAdapter({
    clientId: client.clientId,
    driver: connection.driver,
    config: connection.config,
    secrets: connection.decryptSecrets(),
  });

  let result;
  try {
    const { ok, message, latencyMs, detail } = await adapter.testConnection();
    result = { ok, message, latencyMs, detail, driver: connection.driver };
  } catch (error) {
    result = { ok: false, message: error.message, latencyMs: null, driver: connection.driver };
  }

  connection.lastTest = { ...result, at: new Date(), testedBy: req.auth?.email };
  await connection.save();

  await recordConnectionAudit({
    req, clientId: client.clientId, environment, driver: connection.driver,
    action: AUDIT_ACTIONS.SAP_CONNECTION_TESTED,
    result: { ok: result.ok, message: result.message, latencyMs: result.latencyMs },
  });
  await recordAudit({
    action: AUDIT_ACTIONS.SAP_CONNECTION_TESTED,
    req,
    clientId: client.clientId,
    target: { type: 'SapConnection', id: String(connection._id), label: `${client.clientId}/${environment}` },
    meta: { driver: connection.driver, environment, ok: result.ok, latencyMs: result.latencyMs },
  });

  res.json({ success: true, result: connection.lastTest });
});

// @desc    Switch which environment the tenant runs against
// @route   POST /api/platform/tenants/:clientId/sap/promote
// @access  sap:configure
const promoteSapEnvironment = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);
  const environment = assertEnvironment(req.body.environment);
  const from = client.sapEnvironment || 'sandbox';

  if (from === environment) {
    throw ApiError.badRequest(`This tenant is already running against ${environment}`);
  }

  const connection = await withoutTenantScope(() =>
    SapConnection.findOne({ clientId: client.clientId, environment }));

  if (!connection) throw ApiError.badRequest(`No ${environment} connection is configured for this tenant`);

  // Promotion to production is deliberately gated on a passing test. Going the
  // other way — back to sandbox — is not: that is the rollback, and a rollback
  // you have to qualify for is a rollback you cannot use in an incident.
  if (environment === 'production' && !connection.lastTest?.ok) {
    throw ApiError.badRequest('Test the production connection successfully before promoting the tenant onto it');
  }

  client.sapEnvironment = environment;
  await client.save();

  connection.promotedAt = new Date();
  connection.promotedBy = req.auth?.email;
  await connection.save();

  invalidateSapAdapter(client.clientId);

  await recordConnectionAudit({
    req, clientId: client.clientId, environment, driver: connection.driver,
    action: AUDIT_ACTIONS.SAP_CONNECTION_PROMOTED,
    changes: { activeEnvironment: { from, to: environment } },
  });
  await recordAudit({
    action: AUDIT_ACTIONS.SAP_CONNECTION_PROMOTED,
    req,
    clientId: client.clientId,
    target: { type: 'Client', id: client.clientId, label: client.companyName },
    meta: { from, to: environment, driver: connection.driver, reason: req.body.reason },
  });

  res.json({ success: true, activeEnvironment: environment });
});

// @desc    The connection's change history
// @route   GET /api/platform/tenants/:clientId/sap/audit
// @access  sap:configure
const listSapAudit = asyncHandler(async (req, res) => {
  const client = await findClientOr404(req.params.clientId);
  const { environment, action, page = 1, limit = 50 } = req.query;

  const filter = { clientId: client.clientId };
  if (environment) filter.environment = assertEnvironment(environment);
  if (action) filter.action = action;

  const perPage = Math.min(Number(limit) || 50, 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * perPage;

  const [entries, total] = await withoutTenantScope(async () => [
    await SapConnectionAudit.find(filter).sort({ at: -1 }).skip(skip).limit(perPage),
    await SapConnectionAudit.countDocuments(filter),
  ]);

  res.json({
    success: true,
    entries,
    pagination: { total, page: Number(page), limit: perPage, pages: Math.ceil(total / perPage) },
  });
});

module.exports = {
  getSapConfiguration,
  configureSap,
  testSapConnection,
  promoteSapEnvironment,
  listSapAudit,
};
