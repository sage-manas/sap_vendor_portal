const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const buildTestApp = require('./testApp');
const { registerVendor, createOperatorSession } = require('./helpers');
const { apiLimiter } = require('../middleware/rateLimiter');

const app = buildTestApp();

// One shared office IP is a fine reason not to limit logins per IP; a single
// account being guessed at is the thing to limit. Failures are counted per
// normalised identifier: the first few are free, the next ones are answered
// progressively slower, and at ten the account is locked for 15 minutes
// (429 + Retry-After, even for the right password). The identifier does not
// need to belong to a real account, so an attacker learns nothing from which
// ones lock.

const login = (identifier, password = 'Wrong-password-1') =>
  request(app).post('/api/auth/login').set('x-client-slug', 'legacy').send({ vendorIdOrEmail: identifier, password });

const failTimes = async (n, identifier = 'nobody@example.com') => {
  for (let i = 0; i < n; i += 1) {
    const res = await login(identifier);
    expect(res.status).toBe(401);
  }
};

describe('per-account login lockout', () => {
  it('locks an account after ten failures, and refuses even the right password', async () => {
    const { payload } = await registerVendor(app);
    await failTimes(10, payload.email);

    const right = await login(payload.email, payload.password);
    expect(right.status).toBe(429);
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(right.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
    expect(right.body.token).toBeUndefined();
  });

  it('lets the account back in after fifteen minutes', async () => {
    const { payload } = await registerVendor(app);
    await failTimes(10, payload.email);
    expect((await login(payload.email, payload.password)).status).toBe(429);

    const realNow = Date.now;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 15 * 60 * 1000 + 1000);
    try {
      expect((await login(payload.email, payload.password)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('counts the same account however the identifier is written', async () => {
    const { payload } = await registerVendor(app);
    for (let i = 0; i < 5; i += 1) {
      await login(payload.email.toUpperCase());
      await login(`  ${payload.email}  `);
    }
    expect((await login(payload.email, payload.password)).status).toBe(429);
  });

  it('answers a made-up account exactly as it answers a real one', async () => {
    await failTimes(10, 'nobody@example.com');
    const res = await login('nobody@example.com');
    expect(res.status).toBe(429);
  });

  it('does not lock other accounts', async () => {
    const { payload } = await registerVendor(app);
    await failTimes(10, 'someone-else@example.com');
    expect((await login(payload.email, payload.password)).status).toBe(200);
  });

  it('forgets the failures once the right password is used', async () => {
    const { payload } = await registerVendor(app);
    await failTimes(4, payload.email);
    expect((await login(payload.email, payload.password)).status).toBe(200);
    await failTimes(9, payload.email);
    expect((await login(payload.email, payload.password)).status).toBe(200);
  });

  it('slows the attempts that follow the free ones', async () => {
    process.env.AUTH_DELAY_BASE_MS = '80';
    try {
      await failTimes(5);
      const started = Date.now();
      await login('nobody@example.com');
      expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    } finally {
      process.env.AUTH_DELAY_BASE_MS = '1';
    }
  });

  it('locks an operator account on the platform login the same way', async () => {
    const { operator } = await createOperatorSession();
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).post('/api/platform/auth/login').send({ email: operator.email, password: 'Wrong-password-1' });
      expect(res.status).toBe(401);
    }
    const right = await request(app).post('/api/platform/auth/login').send({ email: operator.email, password: 'secret123' });
    expect(right.status).toBe(429);
  });
});

describe('per-account limits on forgot-password and reset-password', () => {
  const forgot = (email) => request(app).post('/api/auth/forgot-password').set('x-client-slug', 'legacy').send({ email });

  it('allows five reset requests for one address in the window, then answers 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await forgot('Someone@Example.com')).status).toBe(200);
    }
    const sixth = await forgot('someone@example.com');
    expect(sixth.status).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();

    expect((await forgot('another@example.com')).status).toBe(200);
  });

  it('gives a real and an unknown address the same treatment', async () => {
    const { payload } = await registerVendor(app);
    for (let i = 0; i < 5; i += 1) {
      await forgot(payload.email);
      await forgot('ghost@example.com');
    }
    expect((await forgot(payload.email)).status).toBe(429);
    expect((await forgot('ghost@example.com')).status).toBe(429);
  });

  it('locks a reset token after ten bad tries', async () => {
    const reset = (token) => request(app).post('/api/auth/reset-password').send({ token, password: 'Sturdy-Passw0rd!' });
    for (let i = 0; i < 10; i += 1) {
      expect((await reset('not-a-real-token')).status).toBe(400);
    }
    expect((await reset('not-a-real-token')).status).toBe(429);
    expect((await reset('a-different-token')).status).toBe(400);
  });
});

describe('unknown accounts still cost a password hash', () => {
  it('runs bcrypt when the account does not exist, so response time does not say so', async () => {
    const spy = jest.spyOn(bcrypt, 'compare');
    try {
      const res = await login('nobody@example.com');
      expect(res.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockClear();
      const platform = await request(app).post('/api/platform/auth/login').send({ email: 'ghost@platform.example.com', password: 'Wrong-password-1' });
      expect(platform.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the per-IP ceiling is an abuse limit, not an office limit', () => {
  it('lets one address make well over a hundred requests in a window', async () => {
    const limited = express();
    limited.set('trust proxy', 1);
    limited.use(apiLimiter);
    limited.get('/ping', (req, res) => res.json({ ok: true }));

    const statuses = [];
    for (let i = 0; i < 150; i += 1) {
      statuses.push((await request(limited).get('/ping')).status);
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });
});
