const express = require('express');
const cors = require('cors');
const request = require('supertest');
const { allowedOrigins, isAllowedOrigin, connectSrc } = require('../config/corsOrigins');
const ApiError = require('../utils/ApiError');
const { errorHandler } = require('../middleware/errorHandler');

// Both CORS handlers used to accept any http://localhost:<port> with no
// environment gate, alongside credentials: true — a dev convenience shipped to
// production. The predicate now lives in one place; these cases pin its
// answers on both sides of NODE_ENV.

// Restores the environment only once fn has actually finished. supertest is
// lazy — the request runs on await, not on the call that builds it — so a
// synchronous finally would put NODE_ENV back before the handler ever reads it.
const withEnv = (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
  }

  const restore = () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };

  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  if (result && typeof result.then === 'function') {
    return Promise.resolve(result).then(
      (value) => { restore(); return value; },
      (error) => { restore(); throw error; },
    );
  }
  restore();
  return result;
};

const production = (fn) => withEnv({
  NODE_ENV: 'production',
  FRONTEND_URL: 'https://portal.example.com',
  ALLOWED_ORIGINS: undefined,
}, fn);

const development = (fn) => withEnv({
  NODE_ENV: 'development',
  FRONTEND_URL: 'http://localhost:3000',
  ALLOWED_ORIGINS: undefined,
}, fn);

describe('origin policy in production', () => {
  it('rejects an arbitrary localhost origin — the reported hole', () => {
    production(() => {
      expect(isAllowedOrigin('http://localhost:8080')).toBe(false);
    });
  });

  it('rejects the dev ports the list used to hardcode', () => {
    production(() => {
      for (const origin of [
        'http://localhost:3000', 'http://127.0.0.1:3000',
        'http://localhost:3001', 'http://127.0.0.1:5173',
        'http://[::1]:3000',
      ]) {
        expect(isAllowedOrigin(origin)).toBe(false);
      }
    });
  });

  it('allows the configured frontend, with or without a trailing slash', () => {
    production(() => {
      expect(isAllowedOrigin('https://portal.example.com')).toBe(true);
    });
    withEnv({ NODE_ENV: 'production', FRONTEND_URL: 'https://portal.example.com/' }, () => {
      expect(isAllowedOrigin('https://portal.example.com')).toBe(true);
    });
  });

  it('allows extra origins from ALLOWED_ORIGINS, trimming whitespace', () => {
    withEnv({
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://portal.example.com',
      ALLOWED_ORIGINS: 'https://admin.example.com, https://ops.example.com',
    }, () => {
      expect(isAllowedOrigin('https://admin.example.com')).toBe(true);
      expect(isAllowedOrigin('https://ops.example.com')).toBe(true);
      expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    });
  });

  it('is not fooled by an origin that merely contains an allowed one', () => {
    production(() => {
      expect(isAllowedOrigin('https://portal.example.com.evil.test')).toBe(false);
      expect(isAllowedOrigin('http://localhost:3000.evil.test')).toBe(false);
    });
  });

  it('keeps localhost out of the CSP connect-src', () => {
    production(() => {
      expect(connectSrc()).toEqual(["'self'", 'https://portal.example.com']);
    });
  });
});

describe('origin policy in development', () => {
  it('allows localhost on any port, including the ones not hardcoded', () => {
    development(() => {
      for (const origin of [
        'http://localhost:3000', 'http://localhost:5173',
        'http://localhost:8080', 'http://127.0.0.1:4321', 'http://[::1]:3000',
      ]) {
        expect(isAllowedOrigin(origin)).toBe(true);
      }
    });
  });

  it('still refuses a remote origin it was never told about', () => {
    development(() => {
      expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    });
  });

  it('lists the app\'s own dev ports', () => {
    development(() => {
      expect(allowedOrigins()).toEqual(expect.arrayContaining([
        'http://localhost:3000', 'http://127.0.0.1:3000',
        'http://localhost:3001', 'http://127.0.0.1:3001',
        'http://localhost:3002', 'http://127.0.0.1:3002',
        'http://localhost:5173', 'http://127.0.0.1:5173',
      ]));
    });
  });

  it('carries localhost in the CSP connect-src', () => {
    development(() => {
      expect(connectSrc()).toContain('http://localhost:3000');
    });
  });
});

// The predicate is only half the fix — these check what the Express handler
// built on it actually answers over HTTP, mirroring server.js's wiring.
describe('the Express CORS handler built on the shared policy', () => {
  const buildCorsApp = () => {
    const app = express();
    app.use(cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, false);
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new ApiError(403, 'CORS policy violation'));
      },
      credentials: true,
    }));
    app.get('/api/health', (req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  };

  it('refuses a localhost origin in production', async () => {
    const res = await production(() => request(buildCorsApp())
      .get('/api/health')
      .set('Origin', 'http://localhost:8080'));

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('echoes the allowed origin with credentials in production', async () => {
    const res = await production(() => request(buildCorsApp())
      .get('/api/health')
      .set('Origin', 'https://portal.example.com'));

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://portal.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('admits the same localhost origin in development', async () => {
    const res = await development(() => request(buildCorsApp())
      .get('/api/health')
      .set('Origin', 'http://localhost:8080'));

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
  });

  it('serves a non-browser request (no Origin) without CORS headers, not a 403', async () => {
    // curl, the nginx health probe, uptime monitors. There is no cross-origin
    // read to protect against, and 403ing these would break them.
    const res = await production(() => request(buildCorsApp()).get('/api/health'));

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
