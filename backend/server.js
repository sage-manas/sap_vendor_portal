const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '.env') }); // Load environment variables first

const logger = require('./utils/logger');
// Before validateEnv and before the mailer assertion below, both of which can
// refuse to boot -- a crash during startup is exactly the kind nobody sees in
// a log file, so reporting has to be live first (go-live item 3.x).
require('./observability/sentry').initSentry({ serviceName: 'api' });
const validateEnv = require('./config/validateEnv');
validateEnv(); // Validate environment before startup

// Invitations and password resets are only useful if they can be delivered.
require('./utils/mailer').assertMailerConfigured();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const connectDB = require('./config/db');
const routes = require('./routes/index');
const { errorHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimiter');
const requestLogger = require('./middleware/requestLogger');
const trustProxy = require('./config/trustProxy');
const { isAllowedOrigin, connectSrc } = require('./config/corsOrigins');

const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const ApiError = require('./utils/ApiError');

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // A handshake with no Origin is not a browser, so there is nothing for
      // CORS to protect: allow it without echoing an origin back.
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS policy violation'));
      }
    },
    credentials: true
  }
});

const { authenticateSocket, recheckAllSockets } = require('./sockets/socketAuth');
const { registerConnectionHandlers } = require('./sockets/connectionHandlers');

// Pre-auth Socket.io connection middleware. A socket's tenant comes from its
// JWT and from nowhere else — it is what every room it may join is keyed on.
// Reloads the account and runs it through the same checks the HTTP `protect`
// middleware does (issue #74) — the old version only verified the JWT
// signature and trusted its claims, so a suspended or demoted account, or one
// whose password had just been changed specifically to end this session,
// could still open a socket.
io.use(authenticateSocket);

registerConnectionHandlers(io);

// The handshake alone only proves a session was valid the moment it opened —
// nothing about an open socket re-runs that check on its own afterwards.
// This is the other half (issue #74): every connected socket, reloaded and
// re-validated on the same cadence as Socket.io's own ping/pong heartbeat, so
// a password change or suspension disconnects a live session within one
// heartbeat instead of waiting out the token's 30-day expiry.
const SOCKET_RECHECK_INTERVAL_MS = Number(process.env.SOCKET_RECHECK_INTERVAL_MS) || (io.engine.opts.pingInterval || 25000);
const recheckTimer = setInterval(() => {
  recheckAllSockets(io).catch((error) => logger.error(`[sockets] periodic recheck errored: ${error.message}`));
}, SOCKET_RECHECK_INTERVAL_MS);
recheckTimer.unref();

app.set('io', io);
app.set('trust proxy', trustProxy());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: connectSrc(),
      frameAncestors: ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));
app.use(compression());

// Express 5 made req.query a getter with no setter. The sanitiser below
// rewrites the object in place, so it needs a writable one — this replaces
// the getter with a plain own property holding the same values.
app.use((req, res, next) => {
  Object.defineProperty(req, 'query', {
    value: { ...req.query },
    writable: true,
    configurable: true,
    enumerable: true,
  });
  next();
});

// Strips `$`-prefixed and dotted keys from request bodies, query and params.
// Generic hardening, NOT injection protection: this database is PostgreSQL
// via Prisma, whose query builder parameterises everything, and the handful
// of raw statements (jobs/queue.js's claim(), utils/nextSequentialId.js) use
// tagged templates that parameterise too. The package is kept despite its
// name because a `$`/`.`-shaped key reaching a JSON column or an object
// spread is still worth refusing.
app.use(mongoSanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Tighten CORS (one shared origin policy — see config/corsOrigins.js)

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header means this is not a browser request — curl, an uptime
    // check, the nginx health probe. There is no cross-origin read to protect
    // against, so let it through with no CORS headers rather than 403ing every
    // non-browser client. `false` here means "send no Access-Control-Allow-
    // Origin", not "reject".
    if (!origin) return callback(null, false);
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new ApiError(403, 'CORS policy violation'));
  },
  credentials: true,
  // PATCH is live (PATCH /users/:id, PATCH /workspace/settings) — it was
  // missing here, which browsers enforce silently: a PATCH from the app
  // itself failed CORS preflight while curl/Supertest, which skip preflight,
  // never saw the problem.
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // x-vendor-id is gone (ADR-0010): the JWT is the only identity the API accepts.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-slug'],
  // Without this, only the CORS-safelisted response headers are readable from
  // JavaScript — Content-Disposition isn't one of them. getBlob() (api-client.js)
  // read null from every download and fell back to naming the file 'export',
  // with no extension (issue #110).
  exposedHeaders: ['Content-Disposition'],
}));

// The job worker process (jobs/worker.js) has no Socket.io server of its
// own — this is how it reaches this process's `io` to push a realtime event.
// Mounted outside /api deliberately: not part of the public API surface.
app.use('/internal', require('./routes/internal.routes')(io));

// Limit JSON body size (except upload routes)
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/uploads')) return next();
  express.json({ limit: '10kb' })(req, res, next);
});

app.use(requestLogger);

if (process.env.NODE_ENV === 'production') {
  app.use('/api', apiLimiter);
}
app.use('/api', routes);
app.use(errorHandler);

const startServer = async () => {
  try {
    logger.info("⏳ Connecting to database...");
    await connectDB();
    
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
