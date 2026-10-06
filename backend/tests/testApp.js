// Minimal express app for tests: same routes + error handling as server.js,
// without sockets, rate limiting, CORS, or the listening server.
const express = require('express');
const routes = require('../routes/index');
const { errorHandler } = require('../middleware/errorHandler');
const trustProxy = require('../config/trustProxy');

const buildTestApp = ({ io = null } = {}) => {
  const app = express();
  // Same proxy trust as server.js, so req.ip means the same thing here as it
  // does in production — see config/trustProxy.js.
  app.set('trust proxy', trustProxy());
  app.use(express.json());

  // Mirrors server.js. Express 5 made `req.query` a getter with no setter, so
  // server.js replaces it with a writable own property — and
  // middleware/validateQuery.js depends on that, because it hands the
  // coerced, defaulted query to the controller by assigning `req.query =
  // result.data`.
  //
  // Without this line that assignment silently does nothing here, and every
  // controller sees the raw string query instead. That made the *rejection*
  // half of pagination testable while the coercion half never ran: existing
  // controllers all re-apply their own `page = 1, limit = 10` and
  // `Number(limit)`, so they never noticed, and `getASNs` — which relies on
  // the middleware's defaults, like a new route reasonably would — failed
  // with a PrismaClientValidationError surfacing as a bare "Invalid request"
  // 400. See issue #226; the divergence is wider than this one property.
  app.use((req, res, next) => {
    Object.defineProperty(req, 'query', {
      value: { ...req.query },
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  });
  if (io !== null) app.use('/internal', require('../routes/internal.routes')(io));
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

module.exports = buildTestApp;
