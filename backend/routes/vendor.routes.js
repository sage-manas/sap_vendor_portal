const router = require('express').Router();
const {
  getProfile,
  createVendor,
  updateProfile,
  submitRegistration,
  approveVendor,
  rejectVendor,
  approveBankChange,
  confirmBankChangeInSap,
  rejectBankChange,
  listVendors,
  getVendorById,
  getPerformance,
  getSapReferenceData
} = require('../controllers/vendor.controller');
const { inviteVendor } = require('../controllers/invitation.controller');

const validate = require('../middleware/validate');
const { noBody } = require('../validators/common.validator');
const validateQuery = require('../middleware/validateQuery');
const { paginationSchema } = require('../validators/pagination.validator');
const { protect, requirePermission } = require('../middleware/auth');
const { tenantLimiter } = require('../middleware/rateLimiter');
const { PERMISSIONS } = require('../config/permissions');
const {
  profileUpdateSchema,
  vendorCreateSchema,
  rejectVendorSchema,
  bankChangeRejectSchema
} = require('../validators/vendor.validator');
const { inviteVendorSchema } = require('../validators/user.validator');

// Supplier self-service. There is no POST /profile: /api/auth/register is the
// only way a supplier account comes into being on its own.
router.get('/profile', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_READ), getProfile);
router.put('/profile', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_WRITE), validate(profileUpdateSchema), updateProfile);
router.post('/profile/submit', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_SUBMIT), validate(noBody), submitRegistration);
router.get('/sap-reference-data', protect, tenantLimiter, requirePermission(PERMISSIONS.PROFILE_READ), getSapReferenceData);

router.get('/performance', protect, tenantLimiter, requirePermission(PERMISSIONS.PERFORMANCE_READ), getPerformance);

// Supplier directory (tenant staff).
router.post('/invitations', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_INVITE), validate(inviteVendorSchema), inviteVendor);
router.post('/', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_CREATE), validate(vendorCreateSchema), createVendor);
router.get('/', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_READ), validateQuery(paginationSchema), listVendors);
router.put('/:id/approve', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(noBody), approveVendor);
router.put('/:id/reject', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(rejectVendorSchema), rejectVendor);
// Same gate as onboarding approval — a bank-account change on an already
// Approved supplier is reviewed the same way the original registration was.
router.put('/:id/bank-change/approve', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(noBody), approveBankChange);
router.put('/:id/bank-change/confirm-sap', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(noBody), confirmBankChangeInSap);
router.put('/:id/bank-change/reject', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_APPROVE), validate(bankChangeRejectSchema), rejectBankChange);
// Last: '/:id' would otherwise swallow '/profile', '/performance' and
// '/sap-reference-data' above it.
router.get('/:id', protect, tenantLimiter, requirePermission(PERMISSIONS.VENDOR_READ), getVendorById);

module.exports = router;
