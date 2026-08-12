const jwt = require('jsonwebtoken');
const Vendor = require('../models/Vendor');
const Client = require('../models/Client');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { planeOf, isPlatformRole } = require('../config/roles');

// Identity is resolved before any tenant is known, so these two lookups are
// explicitly unscoped. They are the only unscoped reads in the request path.
const findAccountForToken = (decoded) =>
  withoutTenantScope(() => Vendor.findOne({ $or: [{ _id: decoded.id }, { vendorId: decoded.vendorId }] }));

const findAccountByVendorId = (vendorId) =>
  withoutTenantScope(() => Vendor.findOne({ vendorId }));

const findClient = (clientId) =>
  withoutTenantScope(() => Client.findOne({ clientId }));

// Binds req.vendor's tenant for the remainder of the request. Every route
// behind `protect` therefore runs inside a tenant context, which is what makes
// the Mongoose tenant plugin's "throw when unbound" safe rather than noisy.
const bindTenantAndContinue = async (req, res, next, vendor) => {
  req.vendor = vendor;
  req.vendorId = vendor.vendorId;
  req.clerkUserId = vendor.vendorId; // backward compatibility
  req.clientId = vendor.clientId;
  req.roleScope = planeOf(vendor.role);

  if (isPlatformRole(vendor.role)) {
    // Platform operators have no tenant and must not reach tenant endpoints.
    // Phase 3 gives them their own /api/platform/* surface.
    return next(ApiError.forbidden('Platform accounts cannot access tenant endpoints'));
  }

  if (!vendor.clientId) {
    return next(ApiError.unauthorized('Account is not attached to a tenant'));
  }

  const client = await findClient(vendor.clientId);
  if (!client || !client.isOperational()) {
    return next(ApiError.forbidden('This workspace is not active'));
  }
  req.client = client;

  return runWithTenant(vendor.clientId, () => next());
};

const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // Dev/test-only fallback: lets local requests authenticate via x-vendor-id
  // instead of a JWT. Inert whenever NODE_ENV=production (checked below), so
  // it must never be treated as a supported production auth path.
  if (!token && process.env.NODE_ENV !== 'production') {
    const fallbackVendorId = req.headers['x-vendor-id'];
    if (fallbackVendorId) {
      const vendor = await findAccountByVendorId(fallbackVendorId);
      if (vendor) {
        return bindTenantAndContinue(req, res, next, vendor);
      }
    }
  }

  if (!token) {
    return next(ApiError.unauthorized('Not authorized to access this route, token missing'));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
  } catch (error) {
    return next(ApiError.unauthorized('Not authorized, invalid token'));
  }

  const vendor = await findAccountForToken(decoded);

  if (!vendor) {
    return next(ApiError.unauthorized('Not authorized, vendor not found'));
  }

  // A token minted for one tenant can never act on another, even if the
  // account document was moved.
  if (decoded.clientId && decoded.clientId !== vendor.clientId) {
    return next(ApiError.unauthorized('Not authorized, token tenant mismatch'));
  }

  return bindTenantAndContinue(req, res, next, vendor);
});

// Must run after `protect` — relies on req.vendor being populated
const authorize = (...roles) => (req, res, next) => {
  if (!req.vendor || !roles.includes(req.vendor.role)) {
    return next(ApiError.forbidden('Not authorized for this action'));
  }
  next();
};

module.exports = { protect, authorize };
