const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const { redactDeep } = require('./redact');

// What may not reach a log is decided in utils/redact.js, shared with the
// request logger and the SAP communication log. Applied in place so winston's
// own symbol-keyed fields (level, message, splat) survive.
const sanitizeFormat = winston.format((info) => Object.assign(info, redactDeep({ ...info })));

// Formats
const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  sanitizeFormat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, requestId, method, url, ...meta }) => {
    const reqStr = requestId ? ` [${requestId}]` : '';
    const routeStr = method && url ? ` ${method} ${url}` : '';
    const metaStr = Object.keys(meta).length ? ` | Meta: ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}:${reqStr}${routeStr} ${message}${metaStr}`;
  })
);

// Transports configuration
const logDir = path.join(__dirname, '../logs');

const transports = [
  // Combined log rotation
  new DailyRotateFile({
    filename: path.join(logDir, 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    level: 'info',
  }),
  // Error log rotation
  new DailyRotateFile({
    filename: path.join(logDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    level: 'error',
  })
];

// Add console in non-production/development
if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.Console({
    format: consoleFormat
  }));
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: customFormat,
  transports
});

module.exports = logger;
