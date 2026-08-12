const jwt = require('jsonwebtoken');
const { planeOf, PLANES } = require('../config/roles');

// One place that mints and verifies session tokens, for all three planes.
//
// The claims the API actually enforces are `accountType` (which collection the
// subject lives in), `role`, `roleScope` (its plane) and `clientId`. Anything
// else in the payload is convenience for the client and is re-read from the
// database on every request.

const ACCOUNT_TYPES = {
  VENDOR: 'vendor',
  USER: 'user',
  PLATFORM: 'platform',
};

const PLANE_ACCOUNT_TYPE = {
  [PLANES.SUPPLIER]: ACCOUNT_TYPES.VENDOR,
  [PLANES.TENANT]: ACCOUNT_TYPES.USER,
  [PLANES.PLATFORM]: ACCOUNT_TYPES.PLATFORM,
};

const secret = () => process.env.JWT_SECRET || 'secret';

/**
 * @param {object} account a Vendor, User or PlatformUser document
 */
const signToken = (account) => {
  const plane = planeOf(account.role);
  const accountType = PLANE_ACCOUNT_TYPE[plane];
  if (!accountType) {
    throw new Error(`Cannot sign a token for unknown role "${account.role}"`);
  }

  return jwt.sign(
    {
      sub: String(account._id),
      accountType,
      role: account.role,
      roleScope: plane,
      email: account.email,
      clientId: account.clientId || null,
      // Suppliers keep their business identity in the token: controllers scope
      // supplier reads by vendorId, and it saves a lookup on every request.
      ...(accountType === ACCOUNT_TYPES.VENDOR ? { vendorId: account.vendorId, id: account._id } : {}),
    },
    secret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
};

const verifyToken = (token) => jwt.verify(token, secret());

// Tokens minted before Phase 2 carry `id`/`vendorId` and no `accountType`.
// They can only ever have been supplier or (pre-migration) admin vendors, so
// they resolve as vendor accounts and are re-validated against the account's
// current role.
const normalizeClaims = (decoded) => ({
  ...decoded,
  accountType: decoded.accountType || ACCOUNT_TYPES.VENDOR,
  sub: decoded.sub || decoded.id,
});

module.exports = { ACCOUNT_TYPES, signToken, verifyToken, normalizeClaims };
