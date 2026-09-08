const { rawPrisma } = require('../db/prisma');
const logger = require('../utils/logger');

// Prisma connects lazily on first query, so this exists purely to fail fast
// at startup rather than on the first request — the same reason
// mongoose.connect() used to be awaited here before the Postgres rewrite.
const connectDB = async () => {
  try {
    await rawPrisma.$connect();
    logger.info('✅ PostgreSQL connected');
  } catch (err) {
    logger.error(`❌ Could not connect to PostgreSQL: ${err.message}`);
    throw err;
  }
};

module.exports = connectDB;
