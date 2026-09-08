const express = require('express');
const { internalKey } = require('../utils/internalAuth');
const { vendorRoom, procurementRoom } = require('../utils/socketEmitter');
const logger = require('../utils/logger');

// Process-to-process bridge, not a public API surface. vendorconnect-api is
// the only process holding a live Socket.io server (server.js's `io`);
// vendorconnect-jobs (jobs/worker.js) has none, since a slow SAP call must
// never occupy the event loop serving supplier requests. A job handler that
// wants to push a realtime event — "your delivery was confirmed", "payment
// cleared" — asks this endpoint to emit on its behalf instead. See
// jobs/notify.js for the sending side.
//
// Two independent gates, since either alone is one misconfiguration away
// from exposure: loopback-only (both PM2 apps run on the same host), and the
// shared internal key (utils/internalAuth.js). Both failures answer 404, not
// 401/403 — this endpoint's existence is not for an outside caller to learn.
const restrictToLoopback = (req, res, next) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) return res.status(404).end();
  next();
};

module.exports = (io) => {
  const router = express.Router();

  router.use(express.json({ limit: '10kb' }));
  router.use(restrictToLoopback);

  router.post('/emit', (req, res) => {
    if (req.headers['x-internal-key'] !== internalKey()) return res.status(404).end();

    const { room, event, data } = req.body || {};
    if (!room?.clientId || !event) {
      return res.status(400).json({ error: 'room.clientId and event are required' });
    }

    const target = room.vendorId ? vendorRoom(room.clientId, room.vendorId) : procurementRoom(room.clientId);
    logger.debug(`[internal] relayed emit "${event}" -> ${target}`);
    io.to(target).emit(event, data);
    res.status(204).end();
  });

  return router;
};
