// Replaces the three near-identical canAuthenticate() Mongoose instance
// methods (models/Vendor.js, models/User.js, models/PlatformUser.js) now that
// accounts are plain Prisma rows. Same rules: a vendor may sign in from Draft
// onwards and only an explicit rejection closes the door; a User or
// PlatformUser must be Active.
const canVendorAuthenticate = (vendor) => vendor.status !== 'Rejected';
const canUserAuthenticate = (user) => user.status === 'Active';
const canPlatformUserAuthenticate = (operator) => operator.status === 'Active';

// Dispatches on the same `accountType` values used throughout
// middleware/auth.js / utils/authToken.js ('vendor' | 'user' | 'platform').
const canAuthenticate = (account, accountType) => {
  if (accountType === 'vendor') return canVendorAuthenticate(account);
  if (accountType === 'platform') return canPlatformUserAuthenticate(account);
  return canUserAuthenticate(account);
};

module.exports = { canAuthenticate, canVendorAuthenticate, canUserAuthenticate, canPlatformUserAuthenticate };
