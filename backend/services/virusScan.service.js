const fs = require('fs');
const net = require('net');
const logger = require('../utils/logger');

// Optional ClamAV scan of an upload, over clamd's INSTREAM protocol.
//
//   CLAMAV_HOST         clamd host. Unset = scanning is off and nothing changes.
//   CLAMAV_PORT         default 3310
//   CLAMAV_TIMEOUT_MS   default 10000
//   CLAMAV_REQUIRED     "true" = an unreachable scanner refuses the upload
//                       (503) instead of letting it through unscanned
//
// Verdicts: 'clean' | 'infected' (with the signature) | 'skipped' (not
// configured) | 'error' (configured but unreachable or confused). What an
// 'error' means is policy, applied in refusalFor, not here.

const CHUNK = 64 * 1024;

const settings = () => ({
  host: process.env.CLAMAV_HOST || '',
  port: Number(process.env.CLAMAV_PORT) || 3310,
  timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS) || 10000,
  required: String(process.env.CLAMAV_REQUIRED).toLowerCase() === 'true',
});

const parseReply = (reply) => {
  const text = reply.replace(/\0/g, '').trim();
  if (/ OK$/.test(text)) return { status: 'clean' };
  const found = text.match(/^stream: (.+) FOUND$/);
  if (found) return { status: 'infected', signature: found[1] };
  return { status: 'error', detail: text };
};

const scanFile = (filePath) => new Promise((resolve) => {
  const { host, port, timeoutMs } = settings();
  if (!host) return resolve({ status: 'skipped' });

  let socket;
  let settled = false;
  const done = (result) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(result);
  };

  socket = net.createConnection({ host, port });
  socket.setTimeout(timeoutMs, () => done({ status: 'error', detail: 'scan timed out' }));
  socket.on('error', (error) => done({ status: 'error', detail: error.message }));

  let reply = '';
  socket.on('data', (data) => { reply += data.toString('utf8'); });
  socket.on('end', () => done(parseReply(reply)));

  socket.on('connect', () => {
    socket.write('zINSTREAM\0');
    const file = fs.createReadStream(filePath, { highWaterMark: CHUNK });
    file.on('data', (chunk) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(chunk.length);
      socket.write(length);
      socket.write(chunk);
    });
    file.on('end', () => socket.write(Buffer.alloc(4))); // a zero length ends the stream
    file.on('error', (error) => done({ status: 'error', detail: error.message }));
  });
});

// Scans and applies policy. Resolves to null when the file may be stored,
// otherwise to { status, message } for an ApiError.
const refusalFor = async (filePath) => {
  const result = await scanFile(filePath);

  if (result.status === 'infected') {
    logger.warn(`[upload] malware signature ${result.signature} — file refused`);
    return { status: 422, message: 'The file was refused: it appears to contain malware.' };
  }
  if (result.status === 'error') {
    logger.error(`[upload] virus scan failed: ${result.detail}`);
    if (settings().required) return { status: 503, message: 'The file could not be scanned right now. Please try again shortly.' };
  }
  return null;
};

module.exports = { scanFile, refusalFor };
