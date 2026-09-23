const { mapPrismaError } = require('../utils/prismaErrors');
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  // A Prisma error reaching here means a controller let it propagate rather
  // than catching it itself — a malformed :id with no UUID_RE guard, a unique
  // constraint, a foreign key naming a row this tenant cannot see. Map it to
  // the ApiError shape the rest of the API speaks before falling into the
  // same branch every other error does, so logging/response-shaping below
  // needs no separate path for it.
  const mapped = mapPrismaError(err);
  if (mapped) err = mapped;

  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  // The client sees a message only when something in this codebase decided,
  // on purpose, that this exact text is safe and useful to show — that is
  // what `isOperational` means (see utils/ApiError.js, true by default for
  // every ApiError; also set explicitly on the handful of non-ApiError
  // classes that earn it — SapFieldError, SapNotFoundError,
  // NotImplementedError, CircuitOpenError, InvoicePlanError). Everything
  // else falls back to a generic message: a Prisma error mapPrismaError did
  // not recognise, a raw Node TypeError, SapDriverError (which wraps
  // whatever an upstream SAP call failed with — a Z-endpoint path, SAP's own
  // raw response text), MissingTenantContextError (a message written for a
  // developer reading a stack trace, not an API caller). Before this fix all
  // of those reached the client verbatim (issue #115); only `stack` was
  // gated to development, and the message carries most of the same
  // information stack does.
  const clientMessage = err.isOperational ? message : 'Internal Server Error';

  res.locals.errorMessage = message;

  const response = {
    success: false,
    error: clientMessage,
    code: statusCode,
    ...(err.reason && { reason: err.reason }),
    ...(err.errors && { errors: err.errors }),
    requestId: req.requestId,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  };

  const logMeta = {
    requestId: req.requestId,
    clientId: req.clientId,
    method: req.method,
    url: req.originalUrl || req.url,
    statusCode,
    message
  };

  if (statusCode >= 500) {
    logger.error(`Exception occurred: ${message}`, { ...logMeta, stack: err.stack });
  } else {
    logger.warn(`Operational warning: ${message}`, logMeta);
  }

  res.status(statusCode).json(response);
};

module.exports = { errorHandler };
