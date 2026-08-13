const router = require('express').Router();
const authController = require('../controllers/auth.controller');
const invitationController = require('../controllers/invitation.controller');
const validate = require('../middleware/validate');
const {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  acceptInvitationSchema
} = require('../validators/auth.validator');
const { protect, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');

// Public: identity is being established, so there is no principal to authorize.
// `/workspace` answers which tenant this hostname is, which every signed-out
// screen needs before anyone has a session to read it from.
router.get('/workspace', authController.getWorkspace);
router.post('/register', validate(registerSchema), authController.register);
router.post('/login', validate(loginSchema), authController.login);
router.post('/forgot-password', validate(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), authController.resetPassword);
router.get('/invitations/:token', invitationController.getInvitation);
router.post('/invitations/accept', validate(acceptInvitationSchema), invitationController.acceptInvitation);

// Authenticated: every principal holds self:read.
router.get('/me', protect, requirePermission(PERMISSIONS.SELF_READ), authController.getMe);
router.post('/change-password', protect, requirePermission(PERMISSIONS.SELF_READ), validate(changePasswordSchema), authController.changePassword);

module.exports = router;
