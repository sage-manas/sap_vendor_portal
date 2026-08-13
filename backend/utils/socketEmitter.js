const logger = require('./logger');

const EVENTS = {
  PO_NEW:           'po:new',
  GRN_RECEIVED:     'grn:received',
  PAYMENT_CLEARED:  'payment:cleared',
  RFQ_AWARDED:      'rfq:awarded',
  BID_RECEIVED:     'rfq:bid_received',
  CHAT_MESSAGE:     'chat:message',
  VENDOR_APPROVED:  'vendor:approved',
  LOG_NEW:          'log:new',
};

// Room names are the socket-layer equivalent of the tenant filter: a socket can
// only ever join rooms prefixed with its own JWT's clientId.
const vendorRoom      = (clientId, vendorId) => `client:${clientId}:vendor:${vendorId}`;
const procurementRoom = (clientId) => `client:${clientId}:procurement`;

// clientId is required — an emit without one would cross tenants.
const emitToVendor = (io, clientId, vendorId, event, data) => {
  if (!clientId) {
    throw new Error(`emitToVendor requires a clientId (event: ${event})`);
  }
  if (io && vendorId) {
    const room = vendorRoom(clientId, vendorId);
    logger.debug(`[SocketEmitter] "${event}" → ${room}`);
    io.to(room).emit(event, data);
  }
};

// Emit to all procurement staff of one tenant
const emitToProcurement = (io, clientId, event, data) => {
  if (!clientId) {
    throw new Error(`emitToProcurement requires a clientId (event: ${event})`);
  }
  if (io) {
    const room = procurementRoom(clientId);
    logger.debug(`[SocketEmitter] "${event}" → ${room}`);
    io.to(room).emit(event, data);
  }
};

module.exports = { EVENTS, emitToVendor, emitToProcurement, vendorRoom, procurementRoom };
