// What a connected socket may do once authenticated: which rooms it joins on
// its own and which it may ask for. Lifted out of server.js so it can be
// exercised against a real Socket.io server.
const logger = require('../utils/logger');
const { vendorRoom, procurementRoom } = require('../utils/socketEmitter');
const { recheckSocket } = require('./socketAuth');
const { PLANES } = require('../config/roles');

// The rooms a socket may ask to join, by the plane its account belongs to.
// Deny by default: a plane not listed here, or a room not listed for it, is
// refused. A supplier's own room is joined automatically at connect, never on
// request; the staff room carries every supplier's traffic in the tenant, so
// only tenant staff may ask for it.
const JOINABLE_ROOMS = {
  [PLANES.TENANT]: { join_procurement_room: (socket) => procurementRoom(socket.clientId) },
  [PLANES.SUPPLIER]: {},
};

const roomForRequest = (socket, request) => JOINABLE_ROOMS[socket.roleScope]?.[request]?.(socket) || null;

const registerConnectionHandlers = (io) => {
  io.on('connection', (socket) => {
    logger.info(`🔌 Client connected to Socket.io: ${socket.id} (client: ${socket.clientId}, vendorId: ${socket.clerkUserId})`);

    if (socket.roleScope === PLANES.SUPPLIER && socket.clerkUserId) {
      const room = vendorRoom(socket.clientId, socket.clerkUserId);
      socket.join(room);
      logger.info(`🏢 Socket ${socket.id} joined room: ${room}`);
    }

    socket.on('join_procurement_room', async () => {
      // Re-checked here too, not just at connect (issue #74's suggested fix):
      // a room grant is a fresh privilege, and the periodic sweep could be
      // seconds away from catching a revocation that happened in between.
      if (!(await recheckSocket(socket))) return;
      // Always this socket's own tenant — the client cannot name the room.
      const room = roomForRequest(socket, 'join_procurement_room');
      if (!room) {
        logger.warn(`🚫 Socket ${socket.id} (${socket.roleScope}) denied room join: join_procurement_room`);
        return;
      }
      socket.join(room);
      logger.info(`🏢 Socket ${socket.id} joined room: ${room}`);
    });

    socket.on('disconnect', () => {
      logger.info(`🔌 Client disconnected from Socket.io: ${socket.id}`);
    });
  });
};

module.exports = { registerConnectionHandlers };
