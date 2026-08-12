const router = require('express').Router();
const {
  getProfile,
  createProfile,
  updateProfile,
  submitRegistration,
  approveVendor,
  rejectVendor,
  listVendors,
  getPerformance
} = require('../controllers/vendor.controller');
const { inviteVendor } = require('../controllers/invitation.controller');

const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const { PERMISSIONS } = require('../config/permissions');
const {
  profileCreateSchema,
  profileUpdateSchema,
  rejectVendorSchema
} = require('../validators/vendor.validator');
const { inviteVendorSchema } = require('../validators/user.validator');

// Supplier self-service. POST /profile is the unauthenticated arm of
// registration and resolves its tenant from the request (ADR-0004).
router.post('/profile', validate(profileCreateSchema), createProfile);
router.get('/profile', protect, requirePermission(PERMISSIONS.PROFILE_READ), getProfile);
router.put('/profile', protect, requirePermission(PERMISSIONS.PROFILE_WRITE), validate(profileUpdateSchema), updateProfile);
router.post('/profile/submit', protect, requirePermission(PERMISSIONS.PROFILE_SUBMIT), submitRegistration);

router.get('/performance', protect, requirePermission(PERMISSIONS.PERFORMANCE_READ), getPerformance);

// Supplier directory (tenant staff).
router.post('/invitations', protect, requirePermission(PERMISSIONS.VENDOR_INVITE), validate(inviteVendorSchema), inviteVendor);
router.get('/', protect, requirePermission(PERMISSIONS.VENDOR_READ), listVendors);
router.put('/:id/approve', protect, requirePermission(PERMISSIONS.VENDOR_APPROVE), approveVendor);
router.put('/:id/reject', protect, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(rejectVendorSchema), rejectVendor);

module.exports = router;
