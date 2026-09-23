// Socket.io authentication and re-validation (issue #74).
//
// Before this, io.use() only verified the JWT signature and trusted its
// claims for the socket's lifetime — a supplier suspended or demoted, or an
// account whose password was just changed to end a leaked session, kept a
// live socket (and its room membership) until the token's natural 30-day
// expiry. The HTTP path already reloaded the account and ran it through
// canAuthenticate() on every single request; sockets never did either, even
// once, at connect time.
//
// resolveAccountFromToken (middleware/auth.js) is the one place a token is
// turned into "is this still a valid session, and for whom" — the same
// function the HTTP `protect`/`protectPlatform` middleware calls, so a
// password change or suspension closes both doors identically. This module
// is the socket-side caller of it: once at handshake, and again on an
// interval for every already-connected socket, since nothing about a socket
// connection re-runs middleware on its own once it's open.
const logger = require('../utils/logger');
const { resolveAccountFromToken } = require('../middleware/auth');
const { PLANES } = require('../config/roles');

const tokenFor = (socket) => socket.handshake?.auth?.token;

/**
 * The io.use() handshake middleware. Reloads the account the token names and
 * runs it through every check resolveAccountFromToken applies — role churn,
 * password change, active status — none of which the old signature-only
 * check could see. A platform account has no tenant and nothing here is
 * platform-scoped, so it's refused the same as a missing clientId always was.
 */
const authenticateSocket = async (socket, next) => {
  const token = tokenFor(socket);
  if (!token) {
    return next(new Error('Authentication error: token required'));
  }

  try {
    const { account, claims, plane } = await resolveAccountFromToken(token);
    if (plane === PLANES.PLATFORM || !account.clientId) {
      return next(new Error('Authentication error: token carries no tenant'));
    }
    // The account's own clientId, not the token's claim — a token minted for
    // one tenant must not keep acting on another even if the account moved
    // (the same rule middleware/auth.js's `protect` applies over HTTP).
    if (claims.clientId && claims.clientId !== account.clientId) {
      return next(new Error('Authentication error: token tenant mismatch'));
    }

    socket.clientId = account.clientId;
    socket.accountType = claims.accountType;
    socket.clerkUserId = account.vendorId || null; // suppliers only; staff carry none
    socket.roleScope = plane;
    socket.role = account.role;
    return next();
  } catch (error) {
    return next(new Error('Authentication error: Invalid token'));
  }
};

/**
 * Re-validates one already-connected socket against the same rules the
 * handshake applied, and disconnects it the moment it no longer passes —
 * the piece the handshake alone can never cover, since nothing re-runs it
 * for the life of the connection otherwise. Used both by the periodic sweep
 * below and by a room-join handler that wants an up-to-date answer right
 * before granting a room, not just at connect time.
 *
 * Returns `true` if the socket is still good, `false` if it was disconnected.
 */
const recheckSocket = async (socket) => {
  const token = tokenFor(socket);
  try {
    const { account, claims } = await resolveAccountFromToken(token);
    if (claims.clientId && claims.clientId !== account.clientId) {
      throw new Error('token tenant mismatch');
    }
    return true;
  } catch (error) {
    logger.info(`[sockets] disconnecting ${socket.id || '(remote)'}: ${error.message}`);
    socket.disconnect(true);
    return false;
  }
};

/**
 * The periodic sweep: every currently-connected socket, reloaded and
 * re-checked, one at a time isn't required to be atomic with each other —
 * a socket that fails is simply gone by the next tick if this one's answer
 * raced its own disconnect. `io.fetchSockets()` (not `io.sockets.sockets`)
 * so this works the same whether sockets live in this process or, behind an
 * adapter, another one in the same deployment.
 */
const recheckAllSockets = async (io) => {
  const sockets = await io.fetchSockets();
  await Promise.all(sockets.map((socket) => recheckSocket(socket).catch((error) => {
    logger.error(`[sockets] recheck failed for ${socket.id || '(remote)'}: ${error.message}`);
  })));
};

module.exports = { authenticateSocket, recheckSocket, recheckAllSockets };
