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
 * Which of these identities already belongs to an account, anywhere on the
 * platform — 'vendorId' | 'email' | 'gstin' | null. Login resolves an account
 * before a tenant is known, so this check is deliberately cross-tenant.
 * Checked in this order so the caller can report the specific field that
 * collided, rather than a generic "one of these" — a supplier retrying with a
 * fresh GSTIN has no way to tell that only the email actually conflicted.
 */
const identityConflict = async ({ vendorId, email, gstin }) => {
  const normEmail = email ? String(email).toLowerCase() : null;
  const normGstin = gstin ? String(gstin).toUpperCase() : null;

  if (vendorId && await withoutTenantScope(() => Vendor.exists({ vendorId }))) return 'vendorId';
  if (normEmail && (
    await withoutTenantScope(() => Vendor.exists({ email: normEmail })) ||
    await withoutTenantScope(() => User.exists({ email: normEmail }))
  )) return 'email';
  if (normGstin && await withoutTenantScope(() => Vendor.exists({ gstin: normGstin }))) return 'gstin';

  return null;
};

/**
 * Whether any of these identities already belongs to an account, anywhere on
 * the platform. Kept for callers that only need the yes/no answer.
 */
const identityIsTaken = async (identities) => Boolean(await identityConflict(identities));

// A password nobody knows, for an account whose owner will set their own via
// the link we email them. It exists so the document is never passwordless.
const unguessablePassword = () => crypto.randomBytes(24).toString('base64url');

module.exports = { generateVendorId, identityIsTaken, identityConflict, unguessablePassword };
