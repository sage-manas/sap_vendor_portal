const http = require('http');
const { Server } = require('socket.io');
const { io: connect } = require('socket.io-client');
const { registerVendor, createTenantUser } = require('./helpers');
const buildTestApp = require('./testApp');
const { authenticateSocket } = require('../sockets/socketAuth');
const { registerConnectionHandlers } = require('../sockets/connectionHandlers');
const { EVENTS, emitToProcurement, emitToVendor } = require('../utils/socketEmitter');

const app = buildTestApp();

// join_procurement_room re-validated the token and then granted the tenant's
// staff room to whoever asked — a supplier included. A supplier who joined
// received PO_NEW / INVOICE_NEW / LOG_NEW for every other supplier in the
// tenant. Real Socket.io server and clients below: the point is what a client
// actually receives, not what a handler returns.

let server;
let io;
let url;
const clients = [];

beforeEach(async () => {
  server = http.createServer();
  io = new Server(server);
  io.use(authenticateSocket);
  registerConnectionHandlers(io);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  io.close();
  await new Promise((resolve) => server.close(resolve));
});

const open = async (token) => {
  const client = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  clients.push(client);
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  client.received = [];
  client.onAny((event, data) => client.received.push({ event, data }));
  return client;
};

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

describe('room joins are allowed per plane', () => {
  it('a supplier who asks for the staff room receives nothing meant for staff', async () => {
    const { token } = await registerVendor(app, {}, { onboarded: true });
    const supplier = await open(token);

    supplier.emit('join_procurement_room');
    await settle();

    emitToProcurement(io, 'CLT-0001', EVENTS.PO_NEW, { id: 'PO-OTHER-SUPPLIER' });
    emitToProcurement(io, 'CLT-0001', EVENTS.INVOICE_NEW, { id: 'INV-OTHER-SUPPLIER' });
    emitToProcurement(io, 'CLT-0001', EVENTS.LOG_NEW, { id: 'LOG-1' });
    await settle();

    expect(supplier.received).toEqual([]);
  });

  it('tenant staff who ask for the staff room receive its events', async () => {
    const { token } = await createTenantUser({ role: 'buyer' });
    const staff = await open(token);

    staff.emit('join_procurement_room');
    await settle();

    emitToProcurement(io, 'CLT-0001', EVENTS.PO_NEW, { id: 'PO-1' });
    await settle();

    expect(staff.received).toEqual([{ event: EVENTS.PO_NEW, data: { id: 'PO-1' } }]);
  });

  it('a supplier still receives events addressed to their own room', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    const supplier = await open(token);

    emitToVendor(io, 'CLT-0001', vendor.vendorId, EVENTS.PO_NEW, { id: 'PO-MINE' });
    emitToVendor(io, 'CLT-0001', 'someone_else', EVENTS.PO_NEW, { id: 'PO-THEIRS' });
    await settle();

    expect(supplier.received).toEqual([{ event: EVENTS.PO_NEW, data: { id: 'PO-MINE' } }]);
  });
});
