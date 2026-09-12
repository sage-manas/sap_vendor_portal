const express = require('express');
const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { createAdminUser, asTenant } = require('./helpers');
const { internalKey } = require('../utils/internalAuth');
const trustProxy = require('../config/trustProxy');

// Behind nginx every request arrives from 127.0.0.1, so `req.ip` only means
// "the client" if Express is told to read X-Forwarded-For. Four things read
// req.ip and all four were wrong without it: the per-IP rate limiter, the
// audit trail's ip column, the request logger, and restrictToLoopback — which
// inverts, admitting external callers rather than refusing them.

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const CLIENT_IP = '203.0.113.9';

describe('trust proxy', () => {
  it('is loopback by default — a proxy on this host, not every hop', () => {
    expect(trustProxy()).toBe('loopback');
  });

  it('reads the forwarded client address into req.ip', async () => {
    const app = express();
    app.set('trust proxy', trustProxy());
    app.get('/probe', (req, res) => res.json({ ip: req.ip }));

    const res = await request(app).get('/probe').set('X-Forwarded-For', CLIENT_IP);

    expect(res.body.ip).toBe(CLIENT_IP);
  });

  it('ignores a forwarded address that did not come through a trusted proxy', async () => {
    const app = express();
    app.set('trust proxy', 0); // no hops trusted — a client's own header is noise
    app.get('/probe', (req, res) => res.json({ ip: req.ip }));

    const res = await request(app).get('/probe').set('X-Forwarded-For', CLIENT_IP);

    expect(res.body.ip).not.toBe(CLIENT_IP);
  });
});

describe('restrictToLoopback with the proxy trusted', () => {
  // The internal relay is mounted only when an io server is passed, mirroring
  // server.js. A no-op stub is enough: these cases never reach the emit.
  const ioStub = { to: () => ({ emit: () => {} }) };
  const app = buildTestApp({ io: ioStub });

  it('refuses a proxied external caller even with the right internal key', async () => {
    const res = await request(app)
      .post('/internal/emit')
      .set('X-Forwarded-For', CLIENT_IP)
      .set('x-internal-key', internalKey())
      .send({ room: { clientId: 'CLT-0001' }, event: 'ping' });

    expect(res.status).toBe(404);
  });

  it('still admits a genuine loopback caller from the job worker', async () => {
    const res = await request(app)
      .post('/internal/emit')
      .set('x-internal-key', internalKey())
      .send({ room: { clientId: 'CLT-0001' }, event: 'ping' });

    expect(res.status).toBe(204);
  });
});

describe('the audit trail records the forwarded client address', () => {
  it('stores the client IP, not the proxy, on an audited action', async () => {
    const app = buildTestApp();
    const { token } = await createAdminUser();

    const res = await request(app)
      .patch('/api/workspace/settings')
      .set(auth(token))
      .set('X-Forwarded-For', CLIENT_IP)
      .send({ settings: { 'thresholds.invoiceReviewAmount': 250000 } });
    expect(res.status).toBe(200);

    const entry = await asTenant(() => prisma.auditLog.findFirst({
      where: { action: 'settings.updated' },
      orderBy: { at: 'desc' },
    }));
    expect(entry.ip).toBe(CLIENT_IP);
  });
});
