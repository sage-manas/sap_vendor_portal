const crypto = require('crypto');
const Vendor = require('../models/Vendor');
const User = require('../models/User');
const { withoutTenantScope } = require('./tenantContext');

// Supplier login identities. A supplier can now arrive two ways — self-service
// registration, or created from a tenant's directory — and both need the same
// answers to "what is their vendorId?" and "is this email already someone?".
// They ask here rather than each growing their own copy.

/**
 * Assigns a vendorId server-side so nothing client-supplied has to be trusted
 * as the account's real identity. Retries on the (extremely unlikely) chance of
 * a collision. vendorId is a login identity, so uniqueness spans all tenants.
 */
const generateVendorId = async () => {
  let vendorId;
  let exists = true;
  while (exists) {
    vendorId = `VND-${Math.floor(10000 + Math.random() * 90000)}`;
    exists = await withoutTenantScope(() => Vendor.exists({ vendorId }));
  }
  return vendorId;
};

/**
 * Whether any of these identities already belongs to an account, anywhere on
 * the platform. Login resolves an account before a tenant is known, so this
 * check is deliberately cross-tenant.
 */
const identityIsTaken = async ({ vendorId, email, gstin }) => {
  const or = [
    ...(vendorId ? [{ vendorId }] : []),
    ...(email ? [{ email: String(email).toLowerCase() }] : []),
    ...(gstin ? [{ gstin: String(gstin).toUpperCase() }] : []),
  ];
  if (!or.length) return false;

  if (await withoutTenantScope(() => Vendor.exists({ $or: or }))) return true;
  if (!email) return false;
  return Boolean(await withoutTenantScope(() => User.exists({ email: String(email).toLowerCase() })));
};

// A password nobody knows, for an account whose owner will set their own via
// the link we email them. It exists so the document is never passwordless.
const unguessablePassword = () => crypto.randomBytes(24).toString('base64url');

module.exports = { generateVendorId, identityIsTaken, unguessablePassword };
