const { allRoutes } = require('./routeTable');

// Every route that writes must say what it accepts. A handler that reads
// `req.body` with no schema in front of it takes whatever keys the caller
// sends, and the ones that spread the body into Prisma (createPayment did:
// `...header`) let a caller set columns nobody meant to expose.
//
// A route is guarded when `validate(schema)` is on it (middleware/validate.js
// exposes the schema as `.bodySchema`), and the schema must reject an unknown
// key — zod's default `z.object` silently drops them, which reads as
// validation and is not. Routes that take no body use `validate(noBody)`.
//
// Multipart uploads are the one reviewed exception: multer parses the body, so
// the schema sits after it, and `validate` still applies to the parsed fields.

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const writeRoutes = allRoutes.filter((route) => WRITE_METHODS.has(route.method));

const key = (route) => `${route.method} ${route.path}`;
const schemaOf = (route) => route.handlers.map((handler) => handler.bodySchema).find(Boolean);

// A body key nothing declared. Strict schemas reject it; a plain z.object
// strips it and reports success.
const rejectsUnknownKeys = (schema) => {
  const result = schema.safeParse({ __not_a_declared_field__: 1 });
  return result.success === false
    ? result.error.issues.some((issue) => issue.code === 'unrecognized_keys')
    : false;
};

// Routes whose body is never read at all may be exempt only when a schema
// would add nothing — none today. Keep empty; adding one is a decision.
const EXEMPT = new Set([]);

// Test-only route registered outside production.
const TEST_ONLY = new Set(['POST /emit']);

const checked = writeRoutes.filter((route) => !EXEMPT.has(key(route)) && !TEST_ONLY.has(key(route)));

describe('every write route validates its body with a strict schema', () => {
  it('finds the write routes (guards the walker itself)', () => {
    expect(writeRoutes.length).toBeGreaterThan(60);
  });

  it('no write route is missing validate()', () => {
    expect(checked.filter((route) => !schemaOf(route)).map(key)).toEqual([]);
  });

  it('no write route accepts an undeclared key', () => {
    const lax = checked
      .filter((route) => schemaOf(route))
      .filter((route) => !rejectsUnknownKeys(schemaOf(route)))
      .map(key);
    expect(lax).toEqual([]);
  });
});
