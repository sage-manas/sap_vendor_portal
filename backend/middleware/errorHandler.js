const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;

  // If error is not an instance of ApiError, default to 500 Internal Server Error
  if (!(err instanceof ApiError)) {
    statusCode = err.statusCode || 500;
    message = err.message || 'Internal Server Error';
  }

  res.locals.errorMessage = err.message;

  const response = {
    success: false,
    error: message,
    code: statusCode,
    ...(err.reason && { reason: err.reason }),
    requestId: req.requestId,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  };

  const logMeta = {
    requestId: req.requestId,
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
