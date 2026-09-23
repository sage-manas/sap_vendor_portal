// Issue #74: the Socket.io handshake used to verify only the JWT signature
// and trust its claims — never reloading the account, unlike the HTTP
// `protect` path. sockets/socketAuth.js is the fix: the same
// resolveAccountFromToken() the HTTP middleware uses, called once at
// handshake and again on a periodic sweep of every connected socket, so a
// password change or suspension actually ends a live session instead of
// waiting out the token's 30-day expiry.
const { registerVendor, createTenantUser, createPlatformUser, asTenant } = require('./helpers');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { authenticateSocket, recheckSocket, recheckAllSockets } = require('../sockets/socketAuth');

const app = buildTestApp(); // registerVendor/createTenantUser need a real app to hit

const fakeSocket = (token, overrides = {}) => ({
  id: 'sock-test',
  handshake: { auth: { token } },
  disconnect: jest.fn(),
  ...overrides,
});

describe('authenticateSocket (handshake)', () => {
  it('accepts a valid supplier token and attaches the account\'s current fields', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_socket_1', email: 'socket1@example.com', gstin: '27AABCS0001A1Z1' }, { onboarded: true });
    const socket = fakeSocket(token);
    const next = jest.fn();

    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith(); // no error argument
    expect(socket.clientId).toBe('CLT-0001');
    expect(socket.clerkUserId).toBe(vendor.vendorId);
    expect(socket.roleScope).toBe('supplier');
  });

  it('rejects a connection with no token', async () => {
    const socket = fakeSocket(undefined);
    const next = jest.fn();

    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects an invalid/garbage token', async () => {
    const socket = fakeSocket('not-a-real-jwt');
    const next = jest.fn();

    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects a suspended tenant user\'s token', async () => {
    const { token, user } = await createTenantUser({ role: 'buyer' });
    await asTenant(() => prisma.user.update({ where: { pk: user.pk }, data: { status: 'Suspended', suspendedAt: new Date() } }));

    const socket = fakeSocket(token);
    const next = jest.fn();
    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects a token issued before the account\'s password was changed', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_socket_2', email: 'socket2@example.com', gstin: '27AABCS0002A1Z2' }, { onboarded: true });
    await asTenant(() => prisma.vendor.update({ where: { pk: vendor.pk }, data: { passwordChangedAt: new Date(Date.now() + 5000) } }));

    const socket = fakeSocket(token);
    const next = jest.fn();
    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects a platform account — no tenant to scope a room to', async () => {
    const { token } = await createPlatformUser();
    const socket = fakeSocket(token);
    const next = jest.fn();

    await authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('recheckSocket (already-connected sockets)', () => {
  it('leaves a still-valid session alone', async () => {
    const { token } = await registerVendor(app, { vendorId: 'vendor_socket_3', email: 'socket3@example.com', gstin: '27AABCS0003A1Z3' }, { onboarded: true });
    const socket = fakeSocket(token);

    const ok = await recheckSocket(socket);

    expect(ok).toBe(true);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  // The issue's own reproduction: open a socket, then suspend the account —
  // the socket must not survive the next recheck.
  it('disconnects a socket whose account was suspended after it connected', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_socket_4', email: 'socket4@example.com', gstin: '27AABCS0004A1Z4' }, { onboarded: true });
    const socket = fakeSocket(token);
    expect(await recheckSocket(socket)).toBe(true); // valid when it first connected

    await asTenant(() => prisma.vendor.update({ where: { pk: vendor.pk }, data: { status: 'Rejected' } }));

    const ok = await recheckSocket(socket);

    expect(ok).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects a socket whose account changed its password after it connected', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_socket_5', email: 'socket5@example.com', gstin: '27AABCS0005A1Z5' }, { onboarded: true });
    const socket = fakeSocket(token);

    await asTenant(() => prisma.vendor.update({ where: { pk: vendor.pk }, data: { passwordChangedAt: new Date(Date.now() + 5000) } }));

    const ok = await recheckSocket(socket);

    expect(ok).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('recheckAllSockets (the periodic sweep)', () => {
  it('disconnects only the sockets that no longer pass, leaving the rest connected', async () => {
    const good = await registerVendor(app, { vendorId: 'vendor_socket_6', email: 'socket6@example.com', gstin: '27AABCS0006A1Z6' }, { onboarded: true });
    const bad = await registerVendor(app, { vendorId: 'vendor_socket_7', email: 'socket7@example.com', gstin: '27AABCS0007A1Z7' }, { onboarded: true });
    await asTenant(() => prisma.vendor.update({ where: { pk: bad.vendor.pk }, data: { status: 'Rejected' } }));

    const goodSocket = fakeSocket(good.token);
    const badSocket = fakeSocket(bad.token, { id: 'sock-bad' });
    const io = { fetchSockets: jest.fn().mockResolvedValue([goodSocket, badSocket]) };

    await recheckAllSockets(io);

    expect(goodSocket.disconnect).not.toHaveBeenCalled();
    expect(badSocket.disconnect).toHaveBeenCalledWith(true);
  });
});
