const request = require('supertest');
const buildTestApp = require('./testApp');
const { createAdminUser } = require('./helpers');
const { paginationSchema } = require('../validators/pagination.validator');

const app = buildTestApp();
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Issue #118. `GET /api/vendors` — and eight other list endpoints sharing the
// exact same pattern — took `?page`/`?limit` straight from the query string
// into Prisma's `skip`/`take` with no ceiling and no numeric validation:
// `?limit=1000000` returned every row a tenant had in one response, and
// `?limit=abc` reached Prisma as `NaN` and surfaced as a 500 instead of a 400.

describe('paginationSchema', () => {
  it('lets every other query filter through untouched', () => {
    // The one thing that would have made this fix worse than the bug: a
    // schema that silently drops status/search/q/etc. because it only names
    // page and limit. zod strips unrecognised keys by default — .passthrough()
    // is what stops that.
    const result = paginationSchema.parse({ status: 'Approved', search: 'acme', page: '2' });
    expect(result).toMatchObject({ status: 'Approved', search: 'acme', page: 2, limit: 20 });
  });

  it('defaults page to 1 and limit to 20 when neither is given', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  it('refuses a limit above 200 rather than honouring it', () => {
    expect(paginationSchema.safeParse({ limit: '1000000' }).success).toBe(false);
  });

  it('refuses a non-numeric limit rather than letting NaN reach Prisma', () => {
    expect(paginationSchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });

  it('refuses zero and negative values for both page and limit', () => {
    expect(paginationSchema.safeParse({ page: '0' }).success).toBe(false);
    expect(paginationSchema.safeParse({ page: '-1' }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('allows exactly 200 — this app\'s own largest legitimate callers ask for it', () => {
    expect(paginationSchema.safeParse({ limit: '200' }).success).toBe(true);
  });
});

describe('GET /api/vendors query validation, end to end', () => {
  it('no longer returns a whole tenant\'s directory for one request', async () => {
    const { token } = await createAdminUser();

    const res = await request(app).get('/api/vendors?limit=1000000').set(bearer(token));

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('limit');
  });

  it('answers 400, not 500, for a non-numeric limit', async () => {
    const { token } = await createAdminUser();

    const res = await request(app).get('/api/vendors?limit=abc').set(bearer(token));

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('limit');
  });

  it('still honours ?status, unaffected by the new validation', async () => {
    const { token } = await createAdminUser();

    const res = await request(app).get('/api/vendors?status=Approved&limit=5').set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.filters.statuses).toBeTruthy();
  });

  it('a request with no pagination params at all still works', async () => {
    const { token } = await createAdminUser();

    const res = await request(app).get('/api/vendors').set(bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(20);
  });
});
