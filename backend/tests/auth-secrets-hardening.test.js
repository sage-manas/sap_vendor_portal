const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

// 1.11 — three places where an authentication secret was handled loosely:
//   * the loopback relay key was compared with `!==` and was derived from the
//     same JWT_SECRET that signs sessions, so one leak opened both;
//   * jwt.verify accepted whatever HMAC algorithm the token header named;
//   * production booted on a JWT_SECRET of any length.

const withEnv = (vars, fn) => {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  try { return fn(); } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
  }
};

describe('internal relay key', () => {
  const { internalKey, isInternalKey } = require('../utils/internalAuth');

  it('is the INTERNAL_KEY the operator configured, not derived from JWT_SECRET', () => {
    withEnv({ INTERNAL_KEY: 'relay-key-'.repeat(5), JWT_SECRET: 'one-secret' }, () => {
      const before = internalKey();
      process.env.JWT_SECRET = 'another-secret';
      expect(internalKey()).toBe(before);
    });
  });

  it('is not recoverable from a leaked JWT_SECRET once INTERNAL_KEY is set', () => {
    const crypto = require('crypto');
    withEnv({ INTERNAL_KEY: 'relay-key-'.repeat(5), JWT_SECRET: 'leaked-secret' }, () => {
      const derived = crypto.createHmac('sha256', 'leaked-secret').update('internal-relay').digest('hex');
      expect(isInternalKey(derived)).toBe(false);
    });
  });

  it('is required in production — there is no derived fallback to fall into', () => {
    withEnv({ NODE_ENV: 'production', INTERNAL_KEY: undefined, JWT_SECRET: 'x'.repeat(40) }, () => {
      expect(() => internalKey()).toThrow(/INTERNAL_KEY/);
    });
  });

  it('rejects a candidate of the wrong length, a missing one and an array without throwing', () => {
    withEnv({ INTERNAL_KEY: 'relay-key-'.repeat(5) }, () => {
      expect(isInternalKey('short')).toBe(false);
      expect(isInternalKey(undefined)).toBe(false);
      expect(isInternalKey(['relay-key-'.repeat(5)])).toBe(false);
      expect(isInternalKey('relay-key-'.repeat(5))).toBe(true);
    });
  });

  it('the relay endpoint answers 404 to a derived-from-JWT key and 204 to the configured one', async () => {
    const crypto = require('crypto');
    const emitted = [];
    const io = { to: (room) => ({ emit: (event) => emitted.push([room, event]) }) };
    const app = express();
    app.set('trust proxy', false);
    app.use('/internal', require('../routes/internal.routes')(io));

    await withEnv({ INTERNAL_KEY: 'relay-key-'.repeat(5), JWT_SECRET: 'leaked-secret' }, async () => {
      const body = { room: { clientId: 'CLT-1' }, event: 'PO_NEW', data: {} };
      const derived = crypto.createHmac('sha256', 'leaked-secret').update('internal-relay').digest('hex');

      const forged = await request(app).post('/internal/emit').set('x-internal-key', derived).send(body);
      expect(forged.status).toBe(404);
      expect(emitted).toHaveLength(0);

      const real = await request(app).post('/internal/emit').set('x-internal-key', internalKey()).send(body);
      expect(real.status).toBe(204);
      expect(emitted).toHaveLength(1);
    });
  });
});

describe('session token verification', () => {
  const { verifyToken } = require('../utils/authToken');
  const secret = () => process.env.JWT_SECRET;

  it('accepts the HS256 tokens signToken mints', () => {
    const token = jwt.sign({ sub: 'x' }, secret(), { algorithm: 'HS256' });
    expect(verifyToken(token).sub).toBe('x');
  });

  it('rejects a token signed with another HMAC algorithm even under the right secret', () => {
    const token = jwt.sign({ sub: 'x' }, secret(), { algorithm: 'HS512' });
    expect(() => verifyToken(token)).toThrow(/invalid algorithm/);
  });

  it('rejects an unsigned token', () => {
    const token = jwt.sign({ sub: 'x' }, '', { algorithm: 'none' });
    expect(() => verifyToken(token)).toThrow();
  });
});

describe('boot configuration', () => {
  const validateEnv = require('../config/validateEnv');
  const base = {
    NODE_ENV: 'production', PORT: '5000', DATABASE_URL: 'x', FRONTEND_URL: 'https://a.example',
    PORTAL_BASE_DOMAIN: 'a.example', MASTER_KEY: 'k', JWT_SECRET: 'x'.repeat(40), INTERNAL_KEY: 'y'.repeat(40),
    CLAMAV_REQUIRED: '', ADMIN_BOOTSTRAP_EMAILS: '',
    STORAGE_DRIVER: 's3', S3_BUCKET: 'vc-uploads',
  };

  const boots = (overrides) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      withEnv({ ...base, ...overrides }, validateEnv);
      return true;
    } catch (error) {
      if (error.message === 'exit') return false;
      throw error;
    } finally {
      exit.mockRestore();
    }
  };

  it('boots with a 40-character JWT_SECRET and an INTERNAL_KEY', () => {
    expect(boots({})).toBe(true);
  });

  it('refuses to boot in production with a JWT_SECRET shorter than 32 characters', () => {
    expect(boots({ JWT_SECRET: 'x'.repeat(31) })).toBe(false);
  });

  it('refuses to boot in production without an INTERNAL_KEY', () => {
    expect(boots({ INTERNAL_KEY: '' })).toBe(false);
  });

  it('refuses to boot in production with an INTERNAL_KEY shorter than 32 characters', () => {
    expect(boots({ INTERNAL_KEY: 'y'.repeat(31) })).toBe(false);
  });

  it('refuses to boot in production when INTERNAL_KEY equals JWT_SECRET', () => {
    expect(boots({ INTERNAL_KEY: 'x'.repeat(40) })).toBe(false);
  });

  it('does not impose the length floor outside production', () => {
    expect(boots({ NODE_ENV: 'development', JWT_SECRET: 'short', INTERNAL_KEY: '' })).toBe(true);
  });
});
