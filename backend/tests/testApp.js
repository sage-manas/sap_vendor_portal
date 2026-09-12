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
  if (io !== null) app.use('/internal', require('../routes/internal.routes')(io));
  app.use('/api', routes);
  app.use(errorHandler);
  return app;
};

module.exports = buildTestApp;
