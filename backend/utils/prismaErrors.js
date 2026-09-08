const { Prisma } = require('@prisma/client');
const ApiError = require('./ApiError');

// The error handler used to see raw Prisma errors as generic 500s — including
// P2025 "Record not found", which is exactly what db/tenantExtension.js throws
// to refuse a cross-tenant update/delete (see its notFoundError()). That made
// the tenant boundary's own refusal look like a server fault instead of the
// 404 every other "doesn't exist" path already returns, and it happened on
// every malformed :id in a route with no UUID_RE guard (most of them): a
// non-UUID string in a `where: { pk }` fails at the database driver, not in
// application code, as Postgres rejects the string before Prisma ever runs a
// query.
//
// This maps a handful of Prisma error codes to the closest ApiError the rest
// of the API already speaks, without leaking anything a native Prisma error
// carries that a client should not see (SQL, column/constraint names, stack).
//
// It treats a caller-thrown ApiError.notFound() and the tenant extension's
// synthetic P2025 identically — both are "this row is not visible to you",
// and the client has no way to tell a genuinely missing row from one that
// belongs to another tenant, which is the isolation guarantee the extension
// exists for.

// One Prisma code can mean several different things depending on which field
// it names — P2002's `target` says which unique constraint fired. This stays
// deliberately generic (no field names or table names reach the client) since
// none of this backend's uniqueness rules are meant to be discoverable by an
// unauthenticated prober.
const KNOWN_REQUEST_ERROR_MAP = {
  // Record required for the operation was not found — findUniqueOrThrow,
  // update/delete on a non-existent row, or a required relation connect.
  // Same status the rest of the API already uses for "doesn't exist" at the
  // application layer, so a client cannot distinguish "no such row" from
  // "row exists in a tenant you cannot see" — which is the isolation
  // guarantee the extension exists for.
  P2025: () => ApiError.notFound('Not found'),

  // Unique constraint violation — the same business ID, GSTIN, PAN or email
  // was submitted twice. 409 is what the rest of the API already answers a
  // conflict with (see ApiError.conflict).
  P2002: () => ApiError.conflict('A record with that value already exists'),

  // Foreign key constraint violation — the request named a related record
  // (a PO, GRN, vendor…) that does not exist or is not visible to this tenant.
  P2003: () => ApiError.badRequest('Referenced record does not exist'),

  // A value did not fit the column it was destined for — a string longer than
  // its column, most often. Caller error, not a server fault.
  P2000: () => ApiError.badRequest('Provided value is too long for its field'),

  // The `where`/`data` shape Prisma was given could not be interpreted against
  // the schema — e.g. a bare unique key holding a string where the schema
  // expects a UUID column, which Postgres itself rejects before any row is
  // read. This is what a malformed :id route param without a UUID_RE guard
  // (see controllers/vendor.controller.js's comment on this) surfaces as.
  P2023: () => ApiError.badRequest('Invalid identifier'),
};

// Prisma throws PrismaClientValidationError for a request that never reaches
// the database at all — a required field omitted from `data`, an argument of
// the wrong shape. Always a caller mistake.
const isValidationError = (err) => err instanceof Prisma.PrismaClientValidationError;

const isKnownRequestError = (err) => err instanceof Prisma.PrismaClientKnownRequestError;

// Translates a Prisma error into the ApiError the rest of the API already
// speaks, or returns null for anything this map does not recognise — callers
// fall through to the existing generic-500 behaviour for those, unchanged.
const mapPrismaError = (err) => {
  if (isValidationError(err)) {
    return ApiError.badRequest('Invalid request');
  }
  if (isKnownRequestError(err)) {
    const build = KNOWN_REQUEST_ERROR_MAP[err.code];
    if (build) return build();
  }
  return null;
};

module.exports = { mapPrismaError };
