const ApiError = require('../utils/ApiError');
const { driverName, ttlSeconds } = require('./config');

// One answer to "where do uploaded files live". The active driver is chosen by
// STORAGE_DRIVER; a stored Document remembers the driver that holds its bytes
// (`storageDriver`), so rows written before a switch keep working until
// scripts/migrate-uploads-to-object-storage.js moves them.

const DRIVERS = {
  local: () => require('./local'),
  s3: () => require('./s3'),
};

const storageFor = (name) => {
  const load = DRIVERS[name];
  if (!load) throw ApiError.badRequest(`Unknown storage driver "${name}"`);
  return load();
};

const activeStorage = () => storageFor(driverName());

module.exports = { activeStorage, storageFor, ttlSeconds };
