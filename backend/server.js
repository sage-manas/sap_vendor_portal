const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '.env') }); // Load environment variables first

const logger = require('./utils/logger');
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

const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const ApiError = require('./utils/ApiError');

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3002',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  process.env.FRONTEND_URL
].filter(Boolean);
if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','));
}

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      const isLocalhost = origin && (
        origin.startsWith('http://localhost:') || 
        origin.startsWith('http://127.0.0.1:') || 
        origin.startsWith('http://[::1]:')
      );
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/') || isLocalhost) {
        callback(null, true);
      } else {
        callback(new Error('CORS policy violation'));
      }
    },
    credentials: true
  }
});

const jwt = require('jsonwebtoken');
const { vendorRoom, procurementRoom } = require('./utils/socketEmitter');

// Pre-auth Socket.io connection middleware. A socket's tenant comes from its
// JWT and from nowhere else — it is what every room it may join is keyed on.
io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Authentication error: token required'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    if (!decoded.clientId) {
      return next(new Error('Authentication error: token carries no tenant'));
    }
    socket.clientId = decoded.clientId;
    socket.clerkUserId = decoded.vendorId; // suppliers only; staff tokens carry none
    socket.roleScope = decoded.roleScope;
    socket.role = decoded.role;
    return next();
  } catch (err) {
    return next(new Error('Authentication error: Invalid token'));
  }
});

io.on('connection', (socket) => {
  logger.info(`🔌 Client connected to Socket.io: ${socket.id} (client: ${socket.clientId}, vendorId: ${socket.clerkUserId})`);

  if (socket.clerkUserId) {
    const room = vendorRoom(socket.clientId, socket.clerkUserId);
    socket.join(room);
    logger.info(`🏢 Socket ${socket.id} joined room: ${room}`);
  }

  socket.on('join_procurement_room', () => {
    // Always this socket's own tenant — the client cannot name the room.
    const room = procurementRoom(socket.clientId);
    socket.join(room);
    logger.info(`🏢 Socket ${socket.id} joined room: ${room}`);
  });
  
  socket.on('disconnect', () => {
    logger.info(`🔌 Client disconnected from Socket.io: ${socket.id}`);
  });
});

app.set('io', io);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'http://localhost:3000', 'http://127.0.0.1:3000', process.env.FRONTEND_URL].filter(Boolean),
      frameAncestors: ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));
app.use(compression());

// Workaround for express-mongo-sanitize getter issue in Express 5
app.use((req, res, next) => {
  Object.defineProperty(req, 'query', {
    value: { ...req.query },
    writable: true,
    configurable: true,
    enumerable: true,
  });
  next();
});

// Prevent NoSQL query injection
app.use(mongoSanitize());

// Prevent HTTP Parameter Pollution
app.use(hpp());

// Tighten CORS (using the allowedOrigins array declared at the top of the file)

app.use(cors({
  origin: (origin, callback) => {
    const isLocalhost = origin && (
      origin.startsWith('http://localhost:') || 
      origin.startsWith('http://127.0.0.1:') || 
      origin.startsWith('http://[::1]:')
    );
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes(origin + '/') || isLocalhost) {
      callback(null, true);
    } else {
      callback(new ApiError(403, 'CORS policy violation'));
    }
  },
  credentials: true,
  // PATCH is live (PATCH /users/:id, PATCH /workspace/settings) — it was
  // missing here, which browsers enforce silently: a PATCH from the app
  // itself failed CORS preflight while curl/Supertest, which skip preflight,
  // never saw the problem.
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  // x-vendor-id is gone (ADR-0010): the JWT is the only identity the API accepts.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-slug'],
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
