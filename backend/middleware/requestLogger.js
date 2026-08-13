const crypto = require('crypto');
const logger = require('../utils/logger');

const requestLogger = (req, res, next) => {
  // Attach requestId for tracking correlation
  req.requestId = crypto.randomUUID();
  const startTime = process.hrtime();

  // A per-request logger that stamps requestId, and clientId once the tenant
  // is known — `protect` and the pre-auth resolvers set `req.clientId` before
  // any controller runs, so any call site using `req.log` gets the
  // correlation for free without threading `req` through to `logger` calls.
  req.log = {
    info: (message, meta) => logger.info(message, { requestId: req.requestId, clientId: req.clientId, ...meta }),
    warn: (message, meta) => logger.warn(message, { requestId: req.requestId, clientId: req.clientId, ...meta }),
    error: (message, meta) => logger.error(message, { requestId: req.requestId, clientId: req.clientId, ...meta }),
  };

  // Log incoming request
  logger.info(`Incoming request`, {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl || req.url,
    ip: req.ip || req.connection.remoteAddress
  });

  // Track response completion
  res.on('finish', () => {
    const diff = process.hrtime(startTime);
    const responseTimeMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);
    const statusCode = res.statusCode;
    const contentLength = res.get('content-length') || 0;

    const logData = {
      requestId: req.requestId,
      // Set by the time the response finishes for any tenant/supplier route,
      // since `protect` binds it before the handler runs; absent for platform
      // and pre-auth requests, which is the correct, honest answer.
      clientId: req.clientId,
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode,
      responseTimeMs: Number(responseTimeMs),
      contentLength: Number(contentLength),
      ip: req.ip || req.connection.remoteAddress
    };

    // Log request body on warnings/errors for inspection (Sanitizer handles redact)
    if (statusCode >= 400 && req.body && Object.keys(req.body).length > 0) {
      logData.body = req.body;
    }

    if (statusCode >= 500) {
      logger.error(`Request failed with server error ${statusCode}`, logData);
    } else if (statusCode >= 400) {
      logger.warn(`Request warning ${statusCode}`, logData);
    } else {
      logger.info(`Request completed`, logData);
    }
  });

  next();
};

module.exports = requestLogger;
