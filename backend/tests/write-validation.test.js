const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, onboardVendor, createTenantUser, asTenant } = require('./helpers');

const app = buildTestApp();

// The route-table test (write-validation-route-table.test.js) proves every write
// route carries a strict schema. These prove what that means on the wire,
// starting with the handler that made it matter: createPayment spread the whole
// request body into prisma.payment.create.

describe('write routes refuse a body key they do not declare', () => {
  let supplier;
  let finance;
  let admin;

  beforeEach(async () => {
    supplier = await registerVendor(app, {}, { onboarded: false });
    await onboardVendor(supplier.vendor.vendorId, { status: 'Approved' });
    finance = await createTenantUser({ role: 'finance', email: 'fin@example.com' });
    admin = await createTenantUser({ role: 'client_admin', email: 'adm@example.com' });
  });

  const as = (user) => (req) => req.set('Authorization', `Bearer ${user.token}`);
  const paymentCount = () => asTenant(() => prisma.payment.count());

  const validPayment = () => ({
    vendorId: supplier.vendor.vendorId,
    poId: 'PO-1',
    invoiceId: 'INV-1',
    grossAmount: 100,
    netAmount: 100,
    paymentDate: new Date().toISOString(),
    utrCode: 'UTR0000001',
  });

  it('does not let the request body set columns the payment API never exposed', async () => {
    const res = await as(finance)(request(app).post('/api/payments')).send({
      ...validPayment(),
      sapSyncState: 'synced',
      sapDocNumber: '5100000001',
      clientId: 'CLT-9999',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeTruthy();
    expect(await paymentCount()).toBe(0);
  });

  it('refuses a body on a route that reads none', async () => {
    const pk = (await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }))).pk;
    const res = await as(admin)(request(app).put(`/api/vendors/${pk}/bank-change/approve`)).send({ approved: true });
    expect(res.status).toBe(400);
  });

  it('refuses an undeclared key on the supplier profile, rather than dropping it', async () => {
    const res = await as(supplier)(request(app).put('/api/vendors/profile')).send({ status: 'Approved', city: 'Pune' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeTruthy();
  });

  it('refuses an undeclared key in a nested object', async () => {
    const res = await as(supplier)(request(app).put('/api/vendors/profile'))
      .send({ bankDetails: { bankName: 'HDFC', accountNumber: '123456789', secretFlag: true } });
    expect(res.status).toBe(400);
  });

  it('accepts a body-less request where the body is empty or absent', async () => {
    const pk = (await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }))).pk;
    const res = await as(admin)(request(app).put(`/api/vendors/${pk}/approve`));
    // Not a validation failure: whatever the approval answers, it is not a 400 from the schema.
    expect(res.body.errors).toBeUndefined();
  });

  it('refuses an undeclared multipart field on upload, and leaves no file behind', async () => {
    const fs = require('fs');
    const fileName = `rejected-${Date.now()}.pdf`;
    const res = await as(supplier)(request(app).post('/api/uploads'))
      .field('linkedTo', 'Profile')
      .field('isAdmin', 'true')
      .attach('file', Buffer.from('%PDF-1.4 test'), fileName);

    expect(res.status).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dir = require('path').join(__dirname, '../uploads', supplier.vendor.vendorId);
    const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(fileName)) : [];
    expect(leftovers).toEqual([]);
  });
});
