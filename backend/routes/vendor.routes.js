const router = require('express').Router();
const {
  getProfile,
  createProfile,
  createVendor,
  updateProfile,
  submitRegistration,
  approveVendor,
  rejectVendor,
  listVendors,
  getVendorById,
  getPerformance,
  getSapReferenceData
} = require('../controllers/vendor.controller');
const { inviteVendor } = require('../controllers/invitation.controller');

const validate = require('../middleware/validate');
const { protect, requirePermission } = require('../middleware/auth');
const { tenantLimiter } = require('../middleware/rateLimiter');
const { PERMISSIONS } = require('../config/permissions');
const {
  profileCreateSchema,
  profileUpdateSchema,
  vendorCreateSchema,
  rejectVendorSchema
} = require('../validators/vendor.validator');
const { inviteVendorSchema } = require('../validators/user.validator');

// Supplier self-service. POST /profile is the unauthenticated arm of
// registration and resolves its tenant from the request (ADR-0004).
router.post('/profile', validate(profileCreateSchema), createProfile);
router.get('/profile', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_READ), getProfile);
router.put('/profile', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_WRITE), validate(profileUpdateSchema), updateProfile);
router.post('/profile/submit', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_SUBMIT), submitRegistration);
router.get('/sap-reference-data', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_READ), getSapReferenceData);

router.get('/performance', protect, tenantLimiter, requirePermission(PERMISSIONS.PERFORMANCE_READ), getPerformance);

// Supplier directory (tenant staff).
router.post('/invitations', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_INVITE), validate(inviteVendorSchema), inviteVendor);
router.post('/', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_CREATE), validate(vendorCreateSchema), createVendor);
router.get('/', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_READ), listVendors);
router.put('/:id/approve', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), approveVendor);
router.put('/:id/reject', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(rejectVendorSchema), rejectVendor);
// Last: '/:id' would otherwise swallow '/profile', '/performance' and
// '/sap-reference-data' above it.
router.get('/:id', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_READ), getVendorById);

module.exports = router;
