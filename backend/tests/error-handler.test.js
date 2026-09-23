const { errorHandler } = require('../middleware/errorHandler');
const ApiError = require('../utils/ApiError');
const { Prisma } = require('@prisma/client');

// Issue #115. The client used to see err.message verbatim for anything that
// was not an ApiError — a Prisma error mapPrismaError doesn't recognise, a
// raw Node error, SapDriverError (wraps a Z-endpoint path and SAP's own raw
// response text), MissingTenantContextError (written for a developer reading
// a stack trace). Only `stack` was gated to development; the message carries
// most of the same information.
//
// errorHandler is plain Express middleware — (err, req, res, next) => void —
// so it is tested directly here rather than through a real route: every
// error shape below is one call, not a controller wired up to produce it.

const req = (overrides = {}) => ({ requestId: 'req-1', clientId: 'CLT-0001', method: 'GET', originalUrl: '/api/thing', ...overrides });

const mockRes = () => {
  const res = { locals: {} }; // every real Express Response carries .locals
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const run = (err) => {
  const res = mockRes();
  errorHandler(err, req(), res, () => {});
  return res;
};

describe('errorHandler: what reaches the client', () => {
  it('shows an ApiError message — that is what it exists for', () => {
    const res = run(ApiError.badRequest('GSTIN is required'));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('GSTIN is required');
  });

  it('shows an ApiError\'s reason and field errors too', () => {
    const res = run(ApiError.badRequest('Fix these', { reason: 'incomplete_profile', errors: { gstin: 'required' } }));
    expect(res.body.reason).toBe('incomplete_profile');
    expect(res.body.errors).toEqual({ gstin: 'required' });
  });

  it('hides a raw error\'s message — the exact leak this issue is about', () => {
    const res = run(new Error('connect ECONNREFUSED 10.0.4.12:5432'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
    expect(res.body.error).not.toMatch(/10\.0\.4\.12/);
  });

  it('hides a raw error even when it carries its own statusCode', () => {
    // Not every non-ApiError is a 500 — Express itself throws some 4xx
    // errors without going through ApiError. The status is still honoured;
    // only the message is genericised.
    const err = new Error('Unexpected end of JSON input at position 47');
    err.statusCode = 400;
    const res = run(err);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Internal Server Error');
  });

  it('never leaks a Prisma error mapPrismaError does not recognise', () => {
    // A P1001-class connection error, for instance — not in
    // KNOWN_REQUEST_ERROR_MAP, so mapPrismaError returns null and the raw
    // error reaches here with whatever Prisma put in its message (this
    // sandbox instance's connection string, in the wild).
    const res = run(new Error("Can't reach database server at `db.internal:5432`"));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
  });

  it('maps a recognised Prisma error to its ApiError and still shows that message', () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: '6.0.0',
    });
    const res = run(prismaErr);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('A record with that value already exists');
  });

  it('sets the response before the 2>=500 vs warn logging split, from the real message', () => {
    // res.locals is where requestLogger and any downstream middleware read
    // the true message from — it must stay the real one even when the
    // client sees a generic string, or server-side tracing loses the detail
    // the whole point of logging it was to keep.
    const res = mockRes();
    errorHandler(new Error('internal detail'), req(), res, () => {});
    expect(res.locals.errorMessage).toBe('internal detail');
    expect(res.body.error).toBe('Internal Server Error');
  });
});

describe('errorHandler: the SAP error classes that opted in', () => {
  it('shows NotImplementedError\'s message — a safe driver/method classification', () => {
    const { notImplementedDriver } = require('../sap/contract');
    let caught;
    try { notImplementedDriver('ecc_rfc').poAssetCreate({}); } catch (e) { caught = e; }
    const res = run(caught);
    expect(res.statusCode).toBe(501);
    expect(res.body.error).toMatch(/not_implemented: the ecc_rfc driver does not implement/);
  });

  it('hides SapDriverError\'s message — it wraps whatever an upstream call failed with', () => {
    const { SapDriverError } = require('../sap/contract');
    const err = new SapDriverError('SAP asset PO create POST /zasset_po/create failed: 500 Internal Server Error', {
      driver: 's4_odata', method: 'poAssetCreate',
    });
    const res = run(err);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe('Internal Server Error');
    expect(res.body.error).not.toMatch(/zasset_po/);
  });

  it('shows CircuitOpenError\'s message — the caller needs to know to back off', () => {
    const { CircuitOpenError } = require('../sap/circuitBreaker');
    const res = run(new CircuitOpenError('CLT-0001:sandbox', Date.now(), 30000));
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/sap_circuit_open/);
  });

  it('shows InvoicePlanError\'s message — it explains what the caller submitted wrong', () => {
    const { InvoicePlanError } = require('../services/invoicePlan.service');
    const res = run(new InvoicePlanError('percentage must sum to 100'));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('percentage must sum to 100');
  });

  it('shows SapFieldError\'s message — it names which field and why', () => {
    const { SapFieldError } = require('../sap/mappings/fields');
    const res = run(new SapFieldError('LIFNR', 'not-a-vendor-code', 'must be numeric'));
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toMatch(/LIFNR/);
  });

  it('hides MissingTenantContextError\'s message — it is written for a developer, not a caller', () => {
    const { MissingTenantContextError } = require('../utils/tenantContext');
    const res = run(new MissingTenantContextError('Vendor', 'findMany'));
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal Server Error');
  });
});
