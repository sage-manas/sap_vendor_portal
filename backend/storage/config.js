// Storage settings, read from the environment each time they are needed (they
// are cheap, and a test or an operator changing them does not need a restart
// hook). Validated at boot by `problems()`, which config/validateEnv.js calls.

const SSE_MODES = ['AES256', 'aws:kms', 'none'];
const DRIVERS = ['local', 's3'];

const driverName = () => String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();

const ttlSeconds = () => {
  const requested = Number(process.env.SIGNED_URL_TTL_SECONDS);
  const seconds = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 120;
  return Math.min(seconds, 900);
};

const readConfig = () => ({
  bucket: process.env.S3_BUCKET || '',
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT || '',
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === 'true',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  sse: process.env.STORAGE_SSE || 'AES256',
  kmsKeyId: process.env.STORAGE_KMS_KEY_ID || '',
});

// What is wrong with the configuration, as readable strings; empty when fine.
const problems = (env = process.env) => {
  const issues = [];
  const driver = String(env.STORAGE_DRIVER || '').trim().toLowerCase();

  if (driver && !DRIVERS.includes(driver)) issues.push(`STORAGE_DRIVER "${env.STORAGE_DRIVER}" is not one of ${DRIVERS.join(', ')}`);

  if (env.NODE_ENV === 'production' && (driver === '' || driver === 'local') && String(env.STORAGE_ALLOW_LOCAL).toLowerCase() !== 'true') {
    issues.push('uploads would be kept on this server disk, which is lost with it and is not encrypted. Set STORAGE_DRIVER=s3 (and S3_BUCKET), or STORAGE_ALLOW_LOCAL=true to accept that knowingly');
  }

  if (driver === 's3' && !env.S3_BUCKET) issues.push('STORAGE_DRIVER=s3 needs S3_BUCKET');

  const sse = env.STORAGE_SSE;
  if (sse && !SSE_MODES.includes(sse)) issues.push(`STORAGE_SSE "${sse}" is not one of ${SSE_MODES.join(', ')}`);
  if (sse === 'aws:kms' && !env.STORAGE_KMS_KEY_ID) issues.push('STORAGE_SSE=aws:kms needs STORAGE_KMS_KEY_ID');

  return issues;
};

module.exports = { driverName, ttlSeconds, readConfig, problems, SSE_MODES, DRIVERS };
