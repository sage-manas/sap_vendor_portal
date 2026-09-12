const { prisma } = require('../db/prisma');
const logger = require('./logger');
const { getTenantId } = require('./tenantContext');
const { isAuditAction } = require('../config/auditActions');

// The one way anything gets into the audit trail. Call sites name an action
// from config/auditActions.js and pass the request; actor, plane, tenant and IP
// are derived here so no controller can record a half-identified event.

const SECRET_KEY = /pass(word)?|secret|token|credential|apikey|api_key|privatekey|otp|mfa/i;

// Defence in depth: the rule is "never pass a secret to recordAudit", and this
// is what happens when someone does anyway.
const redact = (value, depth = 0) => {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
};

const actorFrom = (req) => {
  if (req?.auth) {
    return {
      actorId: req.auth.id,
      actorRole: req.auth.role,
      actorEmail: req.auth.email,
      plane: req.auth.plane,
    };
  }
  return { actorId: 'system', actorRole: 'system', actorEmail: null, plane: 'system' };
};

/**
 * Appends one entry to the audit trail.
 *
 * @param {object} args
 * @param {string}  args.action    a value from AUDIT_ACTIONS
 * @param {object} [args.req]      the request, for actor and IP
 * @param {object} [args.target]   { type, id, label }
 * @param {object} [args.meta]     context; secrets are redacted, not stored
 * @param {string} [args.clientId] the tenant this concerns; defaults to the
 *                                 bound tenant, or null on the platform plane
 * @param {object} [args.actor]    explicit actor, for scripts and jobs
 */
const recordAudit = async ({ action, req, target, meta = {}, clientId, actor }) => {
  if (!isAuditAction(action)) {
    // A typo'd action would be invisible to every filter in the explorer, so
    // this is a programming error and is thrown, not logged.
    throw new Error(`Unknown audit action "${action}" — add it to config/auditActions.js`);
  }

  const entry = {
    ...actorFrom(req),
    ...(actor || {}),
    action,
    target: target || undefined,
    meta: redact(meta),
    clientId: clientId !== undefined ? clientId : getTenantId(),
    ip: req?.ip || undefined,
    at: new Date(),
  };

  try {
    return await prisma.auditLog.create({ data: entry });
  } catch (error) {
    // A failed audit write must not take down the action it was describing, but
    // it must be loud: this is the log line that says the trail has a hole.
    logger.error(`[audit] failed to record ${action}: ${error.message}`);
    return null;
  }
};

module.exports = { recordAudit, redact };
