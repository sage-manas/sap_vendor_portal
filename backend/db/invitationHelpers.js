const crypto = require('crypto');

// Replaces the crypto statics and instance method that lived on the Mongoose
// Invitation model (models/Invitation.js): hashInviteToken/newInviteToken were
// `module.exports` statics, isRedeemable() was an instance method. Same
// values, same 7-day TTL.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const hashInviteToken = (rawToken) =>
  crypto.createHash('sha256').update(rawToken).digest('hex');

const newInviteToken = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  return { rawToken, tokenHash: hashInviteToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
};

const isRedeemable = (invitation) =>
  invitation.status === 'Pending' && invitation.expiresAt > new Date();

module.exports = { hashInviteToken, newInviteToken, isRedeemable, INVITE_TTL_MS };
