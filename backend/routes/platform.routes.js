const router = require('express').Router();
const platformAuthController = require('../controllers/platformAuth.controller');
const tenantController = require('../controllers/platformTenant.controller');
const operatorController = require('../controllers/platformOperator.controller');
const auditController = require('../controllers/platformAudit.controller');
const healthController = require('../controllers/platformHealth.controller');
const sapController = require('../controllers/platformSap.controller');
const validate = require('../middleware/validate');
const { protectPlatform, requireMfa, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const {
  platformLoginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
} = require('../validators/auth.validator');
const {
  createTenantSchema,
  updateTenantSchema,
  lifecycleSchema,
  createOperatorSchema,
  updateOperatorSchema,
  mfaVerifySchema,
  sapConnectionSchema,
  sapPromoteSchema,
} = require('../validators/platform.validator');

// The platform plane. Two guards stack here and both are required:
//
//   protectPlatform — an operator account, or 404 (never 403: a tenant account
//                     must not learn that this surface exists)
//   requireMfa      — that operator has enrolled a second factor *and* this
//                     token cleared it
//
// The /auth arm below sits behind protectPlatform only, because it is how an
// operator gets to the point of clearing requireMfa. Nothing under it reads or
// writes anything but the caller's own account.

router.post('/auth/login', validate(platformLoginSchema), platformAuthController.login);
router.post('/auth/forgot-password', validate(forgotPasswordSchema), platformAuthController.forgotPassword);
router.post('/auth/reset-password', validate(resetPasswordSchema), platformAuthController.resetPassword);

router.get('/auth/me', protectPlatform, requirePermission(PERMISSIONS.SELF_READ), platformAuthController.getMe);
router.post('/auth/change-password', protectPlatform, requirePermission(PERMISSIONS.SELF_READ), validate(changePasswordSchema), platformAuthController.changePassword);
router.post('/auth/mfa/enrol', protectPlatform, requirePermission(PERMISSIONS.SELF_READ), platformAuthController.enrolMfa);
router.post('/auth/mfa/verify', protectPlatform, requirePermission(PERMISSIONS.SELF_READ), validate(mfaVerifySchema), platformAuthController.verifyMfa);

// Everything below is the console proper: operator + MFA, then a permission.
router.use(protectPlatform, requireMfa);

// Tenants
router.get('/tenants', requirePermission(PERMISSIONS.TENANT_READ), tenantController.listTenants);
router.post('/tenants', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(createTenantSchema), tenantController.createTenant);
router.get('/tenants/:clientId', requirePermission(PERMISSIONS.TENANT_READ), tenantController.getTenant);
router.put('/tenants/:clientId', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(updateTenantSchema), tenantController.updateTenant);
router.post('/tenants/:clientId/suspend', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(lifecycleSchema), tenantController.suspendTenant);
router.post('/tenants/:clientId/reactivate', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(lifecycleSchema), tenantController.reactivateTenant);
router.post('/tenants/:clientId/terminate', requirePermission(PERMISSIONS.TENANT_MANAGE), validate(lifecycleSchema), tenantController.terminateTenant);
router.get('/tenants/:clientId/export', requirePermission(PERMISSIONS.TENANT_MANAGE), tenantController.exportTenant);
router.post('/tenants/:clientId/administrators/:userId/credentials', requirePermission(PERMISSIONS.TENANT_MANAGE), tenantController.reissueCredentials);

// Operators
router.get('/operators', requirePermission(PERMISSIONS.OPERATOR_MANAGE), operatorController.listOperators);
router.post('/operators', requirePermission(PERMISSIONS.OPERATOR_MANAGE), validate(createOperatorSchema), operatorController.createOperator);
router.put('/operators/:id', requirePermission(PERMISSIONS.OPERATOR_MANAGE), validate(updateOperatorSchema), operatorController.updateOperator);
router.post('/operators/:id/suspend', requirePermission(PERMISSIONS.OPERATOR_MANAGE), validate(lifecycleSchema), operatorController.suspendOperator);
router.post('/operators/:id/reactivate', requirePermission(PERMISSIONS.OPERATOR_MANAGE), validate(lifecycleSchema), operatorController.reactivateOperator);
router.post('/operators/:id/mfa/reset', requirePermission(PERMISSIONS.OPERATOR_MANAGE), validate(lifecycleSchema), operatorController.resetMfa);

// SAP configuration, per tenant, per environment. `sap:configure` rather than
// `tenant:manage`: an sap_manager exists to run these screens and nothing else.
router.get('/tenants/:clientId/sap', requirePermission(PERMISSIONS.SAP_CONFIGURE), sapController.getSapConfiguration);
router.get('/tenants/:clientId/sap/audit', requirePermission(PERMISSIONS.SAP_CONFIGURE), sapController.listSapAudit);
router.put('/tenants/:clientId/sap/:environment', requirePermission(PERMISSIONS.SAP_CONFIGURE), validate(sapConnectionSchema), sapController.configureSap);
router.post('/tenants/:clientId/sap/:environment/test', requirePermission(PERMISSIONS.SAP_CONFIGURE), sapController.testSapConnection);
router.post('/tenants/:clientId/sap/promote', requirePermission(PERMISSIONS.SAP_CONFIGURE), validate(sapPromoteSchema), sapController.promoteSapEnvironment);

// Audit explorer
router.get('/audit', requirePermission(PERMISSIONS.PLATFORM_AUDIT_READ), auditController.listAudit);
router.get('/audit/filters', requirePermission(PERMISSIONS.PLATFORM_AUDIT_READ), auditController.auditFilters);

// Health board
router.get('/health', requirePermission(PERMISSIONS.PLATFORM_HEALTH_READ), healthController.platformHealth);

module.exports = router;
