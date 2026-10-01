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
  acceptInvitationSchema,
  confirmEmailSchema
} = require('../validators/auth.validator');
const { protectSession, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { guards } = require('../middleware/accountGuard');

// Public: identity is being established, so there is no principal to authorize.
// `/workspace` answers which tenant this hostname is, which every signed-out
// screen needs before anyone has a session to read it from.
router.get('/workspace', authController.getWorkspace);
router.post('/register', validate(registerSchema), authController.register);
router.post('/confirm-email', validate(confirmEmailSchema), authController.confirmEmail);
// The account guards run after validation (so they see a clean identifier) and
// before the handler; see middleware/accountGuard.js.
router.post('/login', validate(loginSchema), guards.login, authController.login);
router.post('/forgot-password', validate(forgotPasswordSchema), guards.forgotPassword, authController.forgotPassword);
router.post('/reset-password', validate(resetPasswordSchema), guards.resetPassword, authController.resetPassword);
router.get('/invitations/:token', invitationController.getInvitation);
router.post('/invitations/accept', validate(acceptInvitationSchema), invitationController.acceptInvitation);

// Authenticated: every principal holds self:read. These two are the only routes
// open to an account that must still change its temporary password.
router.get('/me', protectSession, requirePermission(PERMISSIONS.SELF_READ), authController.getMe);
router.post('/change-password', protectSession, requirePermission(PERMISSIONS.SELF_READ), validate(changePasswordSchema), authController.changePassword);

module.exports = router;
