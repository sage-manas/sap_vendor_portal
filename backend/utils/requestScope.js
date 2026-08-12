const ApiError = require('./ApiError');

// Which supplier's rows does this request address?
//
// Before Phase 2 every controller answered that with
// `req.clerkUserId || req.headers['x-vendor-id'] || 'mock_vendor_id'`, which
// meant any caller could name any supplier — and, with no token at all, a
// fictional one. That header is gone (ADR-0010); the answer now comes from the
// authenticated principal:
//
//   supplier plane — always their own vendorId, whatever the request says
//   tenant plane   — the whole tenant, unless the caller narrows it explicitly
//                    with ?vendorId= / body.vendorId (still tenant-scoped by
//                    the Mongoose plugin, so it can only ever be their own
//                    tenant's supplier)

const vendorScope = (req) => {
  if (req.scopeVendorId) return req.scopeVendorId;
  return req.query?.vendorId || req.body?.vendorId || null;
};

// For actions that cannot proceed without knowing the supplier (submitting a
// bid, raising an ASN, posting an invoice against a supplier).
const requireVendorScope = (req) => {
  const vendorId = vendorScope(req);
  if (!vendorId) {
    throw ApiError.badRequest('vendorId is required for this action');
  }
  return vendorId;
};

// Adds `{ vendorId }` to a query only when the caller is scoped to one supplier.
const withVendorScope = (req, query = {}) => {
  const vendorId = vendorScope(req);
  return vendorId ? { ...query, vendorId } : query;
};

const isSupplier = (req) => Boolean(req.scopeVendorId);

module.exports = { vendorScope, requireVendorScope, withVendorScope, isSupplier };
