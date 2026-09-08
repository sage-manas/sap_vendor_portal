const { prisma } = require('../db/prisma');
const { hashPassword } = require('../db/credentials');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../utils/audit');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { PLATFORM_ROLES } = require('../config/roles');
const { sendMail } = require('../utils/mailer');
const { frontendUrl } = require('../config/emailTemplates');
const { generatePassword } = require('../services/tenantProvisioning.service');

// Operator CRUD. Only super_admin holds operator:manage — an sap_manager can
// watch every tenant's SAP but cannot make another operator, or promote itself.
//
// MFA is mandatory on this plane (ADR-0016), so a new operator gets a
// temporary password and enrols a second factor before the console will load.
// Nothing here can turn MFA *off*: `resetMfa` clears the enrolment so the
// operator must enrol again, which is the recovery path for a lost device.

const formatOperator = (operator) => ({
  id: operator.pk,
  email: operator.email,
  name: operator.name,
  role: operator.role,
  status: operator.status,
  mfaEnabled: Boolean(operator.mfaEnabled),
  mfaEnrolledAt: operator.mfaEnrolledAt,
  mustChangePassword: Boolean(operator.mustChangePassword),
  lastLoginAt: operator.lastLoginAt,
  createdBy: operator.createdBy,
  createdAt: operator.createdAt,
});

const findOperatorOr404 = async (id) => {
  const operator = await prisma.platformUser.findFirst({ where: { pk: id } }).catch(() => null);
  if (!operator) throw ApiError.notFound('Not found');
  return operator;
};

// @desc    List operators
// @route   GET /api/platform/operators
// @access  operator:manage
const listOperators = asyncHandler(async (req, res) => {
  const operators = await prisma.platformUser.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ success: true, operators: operators.map(formatOperator) });
});

// @desc    Create an operator and email their temporary password
// @route   POST /api/platform/operators
// @access  operator:manage
const createOperator = asyncHandler(async (req, res, next) => {
  const { email, name, role } = req.body;
  const normalized = String(email).toLowerCase().trim();

  if (!PLATFORM_ROLES.includes(role)) {
    return next(ApiError.badRequest(`role must be one of: ${PLATFORM_ROLES.join(', ')}`));
  }
  if (await prisma.platformUser.findFirst({ where: { email: normalized } })) {
    return next(ApiError.conflict('An operator already exists for this email'));
  }

  const plainPassword = generatePassword();
  const { password, passwordChangedAt } = await hashPassword(plainPassword);
  const operator = await prisma.platformUser.create({
    data: {
      email: normalized,
      name,
      role,
      status: 'Active',
      password,
      passwordChangedAt,
      mustChangePassword: true,
      createdBy: req.auth.email,
    },
  });

  await sendMail({
    to: operator.email,
    template: 'operatorCredentials',
    data: {
      name: operator.name,
      email: operator.email,
      temporaryPassword: plainPassword,
      // The console's sign-in is the gate on /platform itself (PlatformGate
      // renders the right step); there is no separate /platform/login route.
      loginUrl: `${frontendUrl()}/platform`,
    },
  });

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.OPERATOR_CREATED,
    clientId: null,
    target: { type: 'PlatformUser', id: operator.pk, label: operator.email },
    meta: { role: operator.role },
  });

  res.status(201).json({
    success: true,
    operator: formatOperator(operator),
    message: `Credentials have been emailed to ${operator.email}.`,
  });
});

// @desc    Change an operator's name or role
// @route   PUT /api/platform/operators/:id
// @access  operator:manage
const updateOperator = asyncHandler(async (req, res, next) => {
  const operator = await findOperatorOr404(req.params.id);
  const { name, role } = req.body;

  if (role && !PLATFORM_ROLES.includes(role)) {
    return next(ApiError.badRequest(`role must be one of: ${PLATFORM_ROLES.join(', ')}`));
  }
  // Demoting yourself out of operator:manage would lock the last door from the
  // inside — and a role change invalidates your own token anyway (ADR-0013).
  if (role && role !== operator.role && operator.pk === req.auth.id) {
    return next(ApiError.badRequest('You cannot change your own role'));
  }

  const changed = {};
  if (name && name !== operator.name) changed.name = { from: operator.name, to: name };
  if (role && role !== operator.role) changed.role = { from: operator.role, to: role };

  const updated = await prisma.platformUser.update({
    where: { pk: operator.pk },
    data: { ...(name && { name }), ...(role && { role }) },
  });

  if (Object.keys(changed).length) {
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.OPERATOR_UPDATED,
      clientId: null,
      target: { type: 'PlatformUser', id: operator.pk, label: operator.email },
      meta: { changed },
    });
  }

  res.json({ success: true, operator: formatOperator(updated) });
});

// Suspension is the delete: an operator's name has to stay attached to the
// audit entries they wrote, so the record is never removed.
const setStatus = (status) => asyncHandler(async (req, res, next) => {
  const operator = await findOperatorOr404(req.params.id);

  if (operator.pk === req.auth.id) {
    return next(ApiError.badRequest('You cannot change your own account status'));
  }
  if (operator.status === status) {
    return res.json({ success: true, operator: formatOperator(operator) });
  }

  // The platform must never end up with no way in.
  if (status === 'Suspended') {
    const remaining = await prisma.platformUser.count({
      where: { role: 'super_admin', status: 'Active', pk: { not: operator.pk } },
    });
    if (operator.role === 'super_admin' && remaining === 0) {
      return next(ApiError.badRequest('This is the last active super admin — create another before suspending this one'));
    }
  }

  const updated = await prisma.platformUser.update({
    where: { pk: operator.pk },
    data: { status },
  });

  await recordAudit({
    req,
    action: status === 'Suspended' ? AUDIT_ACTIONS.OPERATOR_SUSPENDED : AUDIT_ACTIONS.OPERATOR_REACTIVATED,
    clientId: null,
    target: { type: 'PlatformUser', id: operator.pk, label: operator.email },
    meta: { reason: req.body?.reason },
  });

  res.json({ success: true, operator: formatOperator(updated) });
});

// @desc    Clear an operator's MFA enrolment (lost device)
// @route   POST /api/platform/operators/:id/mfa/reset
// @access  operator:manage
const resetMfa = asyncHandler(async (req, res) => {
  const operator = await findOperatorOr404(req.params.id);

  const updated = await prisma.platformUser.update({
    where: { pk: operator.pk },
    data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null },
  });

  await recordAudit({
    req,
    action: AUDIT_ACTIONS.OPERATOR_MFA_RESET,
    clientId: null,
    target: { type: 'PlatformUser', id: operator.pk, label: operator.email },
    meta: { reason: req.body?.reason },
  });

  res.json({
    success: true,
    operator: formatOperator(updated),
    message: `${updated.email} must enrol a new authenticator at their next sign-in.`,
  });
});

module.exports = {
  listOperators,
  createOperator,
  updateOperator,
  suspendOperator: setStatus('Suspended'),
  reactivateOperator: setStatus('Active'),
  resetMfa,
  formatOperator,
};
