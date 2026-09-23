module.exports = {
  testEnvironment: 'node',
  // env.js must precede setup.js: it redirects DATABASE_URL at the test
  // database before db/prisma.js constructs the client (issue #107).
  setupFiles: ['<rootDir>/tests/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testTimeout: 30000,
};
