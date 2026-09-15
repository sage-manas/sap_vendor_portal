const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, onboardVendor, createTenantUser, asTenant } = require('./helpers');

const app = buildTestApp();

// PUT /api/vendors/profile wrote any field not in PROTECTED_VENDOR_FIELDS
// straight to the live row — bankName/accountNumber/ifscCode/accountName
// were never protected, so an already-Approved supplier could repoint their
// own payout account with no re-verification, no approval and no audit
// entry. See issue #53.
describe('vendor bank-account change (issue #53)', () => {
  let supplier;
  let admin;

  beforeEach(async () => {
    supplier = await registerVendor(app, {}, { onboarded: false });
    await onboardVendor(supplier.vendor.vendorId, { status: 'Approved' });
    admin = await createTenantUser({ role: 'client_admin' });
  });

  const asSupplier = (req) => req.set('Authorization', `Bearer ${supplier.token}`);
  const asAdmin = (req) => req.set('Authorization', `Bearer ${admin.token}`);

  const liveVendor = () => asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }));

  it('does not alter the live row, and records an audit entry with old and new values', async () => {
    const before = await liveVendor();

    const res = await asSupplier(request(app).put('/api/vendors/profile')).send({
      accountNumber: '99999999999',
      ifscCode: 'XXXX0000999',
      accountName: 'Not The Supplier',
    });

    expect(res.status).toBe(200);

    const after = await liveVendor();
    expect(after.accountNumber).toBe(before.accountNumber);
    expect(after.ifscCode).toBe(before.ifscCode);
    expect(after.accountName).toBe(before.accountName);
    expect(after.pendingBankChange).toMatchObject({
      accountNumber: '99999999999',
      ifscCode: 'XXXX0000999',
      accountName: 'Not The Supplier',
    });

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.bank_change_requested' } }));
    expect(audit).toBeTruthy();
    expect(audit.meta.old.accountNumber).toBe(before.accountNumber);
    expect(audit.meta.new.accountNumber).toBe('99999999999');
  });

  it('still applies non-bank fields on the same request immediately', async () => {
    const res = await asSupplier(request(app).put('/api/vendors/profile')).send({
      tradeName: 'New Trade Name',
      accountNumber: '99999999999',
    });
    expect(res.status).toBe(200);

    const after = await liveVendor();
    expect(after.tradeName).toBe('New Trade Name');
    expect(after.accountNumber).not.toBe('99999999999');
  });

  it('a supplier not yet approved can still set bank details directly, as part of registration', async () => {
    const draft = await registerVendor(app, {
      vendorId: 'vendor_test_003', companyName: 'Gamma Traders', gstin: '27AABCB1234F1Z7',
      pan: 'AABCB1236F', email: 'gamma@example.com',
    }, { onboarded: false });

    const res = await request(app).put('/api/vendors/profile')
      .set('Authorization', `Bearer ${draft.token}`)
      .send({ accountNumber: '1234567890', ifscCode: 'HDFC0000060' });
    expect(res.status).toBe(200);

    const stored = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: draft.vendor.vendorId } }));
    expect(stored.accountNumber).toBe('1234567890');
    expect(stored.pendingBankChange).toBeNull();
  });

  it('the tenant can approve a pending change, which then applies it to the live row', async () => {
    await asSupplier(request(app).put('/api/vendors/profile')).send({ accountNumber: '99999999999' });
    const pk = (await liveVendor()).pk;

    const res = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));
    expect(res.status).toBe(200);

    const after = await liveVendor();
    expect(after.accountNumber).toBe('99999999999');
    expect(after.pendingBankChange).toBeNull();

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.bank_change_approved' } }));
    expect(audit).toBeTruthy();
  });

  it('the tenant can reject a pending change, which leaves the live row untouched', async () => {
    const before = await (async () => {
      await asSupplier(request(app).put('/api/vendors/profile')).send({ accountNumber: '99999999999' });
      return liveVendor();
    })();
    const pk = before.pk;
    // The live account before the request — captured after the request was
    // made, since the request itself does not change it.
    const originalAccountNumber = before.accountNumber;

    const res = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/reject`)).send({ reason: 'Could not confirm by phone' });
    expect(res.status).toBe(200);

    const after = await liveVendor();
    expect(after.accountNumber).toBe(originalAccountNumber);
    expect(after.pendingBankChange).toBeNull();

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.bank_change_rejected' } }));
    expect(audit).toBeTruthy();
  });

  it('rejects approving or rejecting when there is no pending change', async () => {
    const pk = (await liveVendor()).pk;
    const approve = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));
    expect(approve.status).toBe(400);
    const reject = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/reject`));
    expect(reject.status).toBe(400);
  });

  it('blocks a payment to a supplier with a pending bank change', async () => {
    await asSupplier(request(app).put('/api/vendors/profile')).send({ accountNumber: '99999999999' });
    const finance = await createTenantUser({ role: 'finance' });

    const res = await request(app).post('/api/payments')
      .set('Authorization', `Bearer ${finance.token}`)
      .send({
        vendorId: supplier.vendor.vendorId,
        poId: 'PO-2026-0001',
        netAmount: 100,
        paymentDate: new Date().toISOString(),
        utrCode: 'UTRTEST0001',
      });

    expect(res.status).toBe(400);
    expect(res.body.reason || res.body.error).toBeTruthy();

    const payments = await asTenant(() => prisma.payment.findMany({ where: { vendorId: supplier.vendor.vendorId } }));
    expect(payments).toHaveLength(0);
  });
});
