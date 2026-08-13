const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Password storage and reset-token handling, shared by all three identity
// collections (Vendor, User, PlatformUser) so the rules cannot drift apart.
//
// Reset tokens are stored as a SHA-256 hash: a database leak does not hand an
// attacker a working reset link. Tokens are single-use — consumeResetToken
// clears them in the same save that sets the new password.

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const hashResetToken = (rawToken) =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

module.exports = function credentialsPlugin(schema) {
  schema.add({
    password: { type: String, select: false },
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
    // Set when credentials were issued by someone else (tenant provisioning,
    // operator creation). The login response carries it so the UI can force a
    // change before anything else is allowed.
    mustChangePassword: { type: Boolean, default: false },
    lastLoginAt: { type: Date },
    passwordChangedAt: { type: Date },
  });

  schema.pre('save', async function hashPassword() {
    if (!this.isModified('password') || !this.password) return;
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.passwordChangedAt = new Date();
  });

  schema.methods.comparePassword = async function comparePassword(candidate) {
    if (!this.password || !candidate) return false;
    return bcrypt.compare(candidate, this.password);
  };

  // Issues a raw token to email and stores only its hash. The caller saves.
  schema.methods.issueResetToken = function issueResetToken() {
    const rawToken = crypto.randomBytes(32).toString('hex');
    this.resetPasswordToken = hashResetToken(rawToken);
    this.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    return rawToken;
  };

  schema.methods.consumeResetToken = function consumeResetToken(newPassword) {
    this.password = newPassword;
    this.resetPasswordToken = undefined;
    this.resetPasswordExpires = undefined;
    this.mustChangePassword = false;
  };
};

module.exports.hashResetToken = hashResetToken;
module.exports.RESET_TOKEN_TTL_MS = RESET_TOKEN_TTL_MS;
