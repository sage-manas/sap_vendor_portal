const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Replaces models/plugins/credentialsPlugin.js. Mongoose applied this as a
// pre-save hook, so hashing happened automatically whenever `password` was
// modified; Prisma has no such hook, so each call site that sets a password
// must hash it explicitly before writing. Same three collections as before
// (Vendor, User, PlatformUser), same behavior — just invoked, not implicit.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const hashResetToken = (rawToken) =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

// Call before writing a new/changed password: `hashPassword(plain)` returns
// `{ password, passwordChangedAt }` to spread into the Prisma `data` payload.
const hashPassword = async (plainPassword) => {
  const salt = await bcrypt.genSalt(10);
  const password = await bcrypt.hash(plainPassword, salt);
  return { password, passwordChangedAt: new Date() };
};

const comparePassword = async (candidate, storedHash) => {
  if (!storedHash || !candidate) return false;
  return bcrypt.compare(candidate, storedHash);
};

// A well-formed hash (same cost as real ones) of a password nobody knows.
// Checking a candidate against it costs the same as checking against a real
// account, so a login for an account that does not exist takes as long as one
// with a wrong password — response time is not a way to ask "does this
// account exist?".
const DUMMY_HASH = '$2b$10$G4nhRn6DDl8ezJvdn53NrOfurGP9eN82R62BB9MzUDhOu7VfxoxVG';

const burnPasswordCheck = async (candidate) => {
  await bcrypt.compare(String(candidate || 'x'), DUMMY_HASH);
  return false;
};

// Returns { rawToken, fields } — `fields` is what to write to the row,
// `rawToken` is what to email. Only the hash is ever persisted.
const issueResetToken = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return {
    rawToken,
    fields: {
      resetPasswordToken: hashResetToken(rawToken),
      resetPasswordExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  };
};

// The token that confirms a self-registration. `expires` is a parameter so a
// re-sent link can keep the original deadline instead of extending it.
const issueEmailVerification = (expires = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)) => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return {
    rawToken,
    fields: { emailVerificationToken: hashResetToken(rawToken), emailVerificationExpires: expires },
  };
};

// Returns the fields to write when consuming a reset token with a new
// password: hashes the password and clears the reset/must-change fields in
// one payload, mirroring consumeResetToken()'s single save.
const consumeResetToken = async (newPassword) => {
  const { password, passwordChangedAt } = await hashPassword(newPassword);
  return {
    password,
    passwordChangedAt,
    resetPasswordToken: null,
    resetPasswordExpires: null,
    mustChangePassword: false,
  };
};

module.exports = {
  hashPassword,
  comparePassword,
  burnPasswordCheck,
  issueResetToken,
  issueEmailVerification,
  consumeResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
  EMAIL_VERIFICATION_TTL_MS,
};
