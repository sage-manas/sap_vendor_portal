const router = require('express').Router();
const platformAuthController = require('../controllers/platformAuth.controller');
const validate = require('../middleware/validate');
const { protectPlatform, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const {
  platformLoginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema
} = require('../validators/auth.validator');

// The platform plane. Phase 2 ships identity only; Phase 3 mounts the console's
// tenant, operator, audit and health routes underneath the same guard.
router.post('/auth/login', validate(platformLoginSchema), platformAuthController.login);
router.post('/auth/forgot-password', validate(forgotPasswordSchema), platformAuthController.forgotPassword);
router.post('/auth/reset-password', validate(resetPasswordSchema), platformAuthController.resetPassword);

router.get('/auth/me', protectPlatform, requirePermission(PERMISSIONS.SELF_READ), platformAuthController.getMe);
router.post('/auth/change-password', protectPlatform, requirePermission(PERMISSIONS.SELF_READ), validate(changePasswordSchema), platformAuthController.changePassword);

module.exports = router;
