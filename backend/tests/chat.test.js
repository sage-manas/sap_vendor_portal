const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, asTenant } = require('./helpers');

const app = buildTestApp();

// sendMessage used to schedule a setTimeout that wrote a second, fabricated
// row into chat_messages two seconds later — a keyword-matched "reply"
// attributed to Buyer, Finance, Quality or Warehouse, one of them falsely
// claiming a SAP write had happened. No human sent any of it. See issue #55.
describe('POST /api/chats (issue #55)', () => {
  it('creates exactly one row, attributed to the sender, with no fabricated reply', async () => {
    const { token } = await registerVendor(app, {}, { onboarded: true });

    const res = await request(app)
      .post('/api/chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'What is the price on this order?' });

    expect(res.status).toBe(201);
    expect(res.body.sender).toBe('Vendor');

    const rows = await asTenant(() => prisma.chatMessage.findMany({}));
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('What is the price on this order?');
  });

  // The old auto-reply fired on a 2s timer outside the request; this proves
  // there is nothing left to fire — no fixture waits, no fake timers, just
  // confirming the row count is still one well after that timer would have.
  it('still shows exactly one row a few seconds later — nothing arrives on a timer', async () => {
    const { token } = await registerVendor(app, {}, { onboarded: true });

    await request(app)
      .post('/api/chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'When will this be delivered?' });

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const rows = await asTenant(() => prisma.chatMessage.findMany({}));
    expect(rows).toHaveLength(1);
  }, 10000);

  it('never writes a message claiming a SAP record was updated', async () => {
    const { token } = await registerVendor(app, {}, { onboarded: true });

    await request(app)
      .post('/api/chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'quality issue: items arrived defective' });

    const rows = await asTenant(() => prisma.chatMessage.findMany({}));
    for (const row of rows) {
      expect(row.message.toLowerCase()).not.toMatch(/updated the transaction record in sap/);
    }
  });
});
