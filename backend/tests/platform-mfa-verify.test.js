// POST /api/platform/auth/mfa/verify is the second half of the operator login,
// and it is guessable in a way the first half is not: six digits, reachable
// with nothing but a stolen password. Issue #246. So it gets what login gets —
// a per-operator lockout and an audit entry per failure — plus the thing a
// password does not need: one code, one verification.
const request = require('supertest');
const buildTestApp = require('./testApp');

const { rawPrisma } = require('../db/prisma');
const { createOperatorSession } = require('./helpers');
const { signToken } = require('../utils/authToken');
const totp = require('../utils/totp');

const app = buildTestApp();

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// What an operator holds between the password and the code.
const halfSessionFor = (operator) => signToken(operator, { mfa: false });

const verify = (token, code) =>
  request(app).post('/api/platform/auth/mfa/verify').set(bearer(token)).send({ code });

const failuresFor = (operatorId) => rawPrisma.auditLog.findMany({
  where: { action: 'operator.mfa_failed', actorId: operatorId },
  orderBy: { at: 'asc' },
});

describe('operator MFA verification — one code, one use', () => {
  it('accepts a code once and refuses the same code again', async () => {
    const { operator, secret } = await createOperatorSession();
    const token = halfSessionFor(operator);
    const code = totp.generateToken(secret);

    const first = await verify(token, code);
    expect(first.status).toBe(200);
    expect(first.body.token).toBeTruthy();

    const replay = await verify(halfSessionFor(operator), code);
    expect(replay.status).toBe(401);
    expect(replay.body.reason).toBe('mfa_code_already_used');
    expect(replay.body.token).toBeUndefined();

    // The session the real verification minted is untouched by the refusal.
    const allowed = await request(app).get('/api/platform/tenants').set(bearer(first.body.token));
    expect(allowed.status).toBe(200);
  });

  it('refuses a code from a step that has already been spent', async () => {
    const { operator, secret } = await createOperatorSession();
    const now = Date.now();

    // The step before the current one is still inside the drift window, so it
    // would otherwise be accepted after the current one had been used.
    const earlier = totp.generateToken(secret, now - totp.STEP_SECONDS * 1000);
    expect((await verify(halfSessionFor(operator), totp.generateToken(secret, now))).status).toBe(200);

    const stale = await verify(halfSessionFor(operator), earlier);
    expect(stale.status).toBe(401);
    expect(stale.body.reason).toBe('mfa_code_already_used');
  });

  it('lets the next step through, so a second sign-in is not blocked', async () => {
    const { operator, secret } = await createOperatorSession();
    const now = Date.now();

    expect((await verify(halfSessionFor(operator), totp.generateToken(secret, now))).status).toBe(200);

    const later = now + 2 * totp.STEP_SECONDS * 1000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => later);
    try {
      expect((await verify(halfSessionFor(operator), totp.generateToken(secret, later))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not spend a step when the code is wrong', async () => {
    const { operator, secret } = await createOperatorSession();

    expect((await verify(halfSessionFor(operator), '000000')).status).toBe(401);
    expect((await verify(halfSessionFor(operator), totp.generateToken(secret))).status).toBe(200);
  });
});

describe('operator MFA verification — failures are limited and recorded', () => {
  it('locks the operator after five wrong codes, and refuses even the right one', async () => {
    const { operator, secret } = await createOperatorSession();
    const token = halfSessionFor(operator);

    for (let i = 0; i < 5; i += 1) {
      expect((await verify(token, '000000')).status).toBe(401);
    }

    const right = await verify(token, totp.generateToken(secret));
    expect(right.status).toBe(429);
    expect(Number(right.headers['retry-after'])).toBeGreaterThan(0);
    expect(right.body.token).toBeUndefined();
  });

  it('locks that operator only', async () => {
    const { operator } = await createOperatorSession();
    const other = await createOperatorSession({ email: 'second@platform.example.com' });

    for (let i = 0; i < 5; i += 1) await verify(halfSessionFor(operator), '000000');

    expect((await verify(halfSessionFor(operator), '000000')).status).toBe(429);
    expect((await verify(halfSessionFor(other.operator), totp.generateToken(other.secret))).status).toBe(200);
  });

  it('forgets the failures once a code is accepted', async () => {
    const { operator, secret } = await createOperatorSession();

    for (let i = 0; i < 4; i += 1) await verify(halfSessionFor(operator), '000000');
    expect((await verify(halfSessionFor(operator), totp.generateToken(secret))).status).toBe(200);

    for (let i = 0; i < 4; i += 1) {
      expect((await verify(halfSessionFor(operator), '000000')).status).toBe(401);
    }
  });

  it('records every failed code in the audit trail, and never the code itself', async () => {
    const { operator, secret } = await createOperatorSession();
    const code = totp.generateToken(secret);

    await verify(halfSessionFor(operator), '000000');
    await verify(halfSessionFor(operator), code);
    await verify(halfSessionFor(operator), code);

    const entries = await failuresFor(operator.pk);
    expect(entries.map((entry) => entry.meta.reason)).toEqual(['invalid_code', 'code_already_used']);

    for (const entry of entries) {
      expect(entry.plane).toBe('platform');
      expect(entry.clientId).toBeNull();
      expect(entry.target.id).toBe(operator.pk);
      expect(JSON.stringify(entry)).not.toContain(code);
      expect(JSON.stringify(entry)).not.toContain('000000');
    }
  });

  it('records nothing for a successful code beyond the enrolment it completes', async () => {
    const { operator, secret } = await createOperatorSession();
    expect((await verify(halfSessionFor(operator), totp.generateToken(secret))).status).toBe(200);
    expect(await failuresFor(operator.pk)).toEqual([]);
  });
});
