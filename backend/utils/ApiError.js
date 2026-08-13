class ApiError extends Error {
  // `reason` is an optional machine-readable code for cases where the client
  // must branch on *which* refusal it got — the MFA gate is the first: "enrol"
  // and "enter your code" are different screens. It rides alongside the
  // response's `code`, which has always been the HTTP status.
  //
  // `errors` is a field → message map, the same shape middleware/validate.js
  // returns for a zod failure. Validation that cannot be expressed as a schema
  // — a driver checking its own connection settings, since only the driver
  // knows what they are — refuses through here, and the client renders both
  // the same way.
  constructor(statusCode, message, { isOperational = true, reason, errors } = {}) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.reason = reason;
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor);
  }
  static notFound(msg = 'Not found', opts)     { return new ApiError(404, msg, opts); }
  static badRequest(msg, opts)                 { return new ApiError(400, msg, opts); }
  static unauthorized(msg = 'Unauthorized', opts) { return new ApiError(401, msg, opts); }
  static forbidden(msg = 'Forbidden', opts)    { return new ApiError(403, msg, opts); }
  static conflict(msg, opts)                   { return new ApiError(409, msg, opts); }
  static internal(msg = 'Internal Server Error', opts) { return new ApiError(500, msg, opts); }
}
module.exports = ApiError;
