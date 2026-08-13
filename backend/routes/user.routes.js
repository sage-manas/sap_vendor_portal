const router = require('express').Router();
const userController = require('../controllers/user.controller');
const invitationController = require('../controllers/invitation.controller');
const validate = require('../middleware/validate');
const { requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const { inviteUserSchema, updateUserSchema, userStatusSchema } = require('../validators/user.validator');

// Tenant staff management. Mounted behind `protect`, so every handler here
// already runs inside a bound tenant.
router.get('/invitations', requirePermission(PERMISSIONS.USER_READ), invitationController.listInvitations);
router.post('/invitations', requirePermission(PERMISSIONS.USER_INVITE), validate(inviteUserSchema), invitationController.inviteUser);
router.delete('/invitations/:id', requirePermission(PERMISSIONS.USER_MANAGE), invitationController.revokeInvitation);

// Before /:id, or "roles" would be read as an account id.
router.get('/roles', requirePermission(PERMISSIONS.USER_READ), userController.listRoles);

router.get('/', requirePermission(PERMISSIONS.USER_READ), userController.listUsers);
router.get('/:id', requirePermission(PERMISSIONS.USER_READ), userController.getUser);
router.patch('/:id', requirePermission(PERMISSIONS.USER_MANAGE), validate(updateUserSchema), userController.updateUser);
router.put('/:id/status', requirePermission(PERMISSIONS.USER_MANAGE), validate(userStatusSchema), userController.setUserStatus);

module.exports = router;
