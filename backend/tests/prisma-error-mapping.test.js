// backend/utils/prismaErrors.js translates a handful of Prisma errors into
// the ApiError shape the rest of the API speaks. Before it existed, any of
// these reached middleware/errorHandler.js as a bare Prisma error and fell
// into the generic-500 branch — including P2025 "Record not found", which is
// exactly what db/tenantExtension.js throws to refuse a cross-tenant
// update/delete (see tenant-isolation.test.js for that guarantee itself).
// This suite exercises the translation through the real HTTP surface: a
// malformed :id reaching a route with no UUID_RE guard.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { createAdminUser } = require('./helpers');

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('malformed identifiers answer 400, never 500', () => {
  it('PATCH /api/users/:id with a non-UUID id', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .patch('/api/users/not-a-uuid')
      .set(auth(token))
      .send({ jobTitle: 'Anything' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeTruthy();
  });

  it('PUT /api/users/:id/status with a non-UUID id', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .put('/api/users/../../etc/passwd/status')
      .set(auth(token))
      .send({ status: 'Suspended' });

    // Path traversal in a route param is just more non-UUID text to Express;
    // the assertion is the same one — never a 500 — whatever the string was
    // trying to do.
    expect(res.status).not.toBe(500);
  });

  it('DELETE /api/users/invitations/:id with a non-UUID id', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .delete('/api/users/invitations/undefined')
      .set(auth(token));

    expect(res.status).toBe(400);
  });

  it('GET /api/uploads/:id with a non-UUID id', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .get('/api/uploads/1234')
      .set(auth(token));

    expect(res.status).toBe(400);
  });

  it('a genuinely missing UUID still answers 404, not 400', async () => {
    const { token } = await createAdminUser();
    const res = await request(app)
      .patch('/api/users/00000000-0000-0000-0000-000000000000')
      .set(auth(token))
      .send({ jobTitle: 'Anything' });

    expect(res.status).toBe(404);
  });
});
