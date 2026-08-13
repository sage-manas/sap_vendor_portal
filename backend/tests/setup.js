const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

// Every request path now resolves a tenant, so a deployment — and therefore a
// test database — always has at least one. This is the same CLT-0001 "Legacy"
// client the migration script creates.
beforeEach(async () => {
  const { seedClient } = require('./helpers');
  await seedClient();
});

afterEach(async () => {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) {
    await collection.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});
