const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { invalidateSapAdapter } = require('../sap');
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

// F110 pays from SAP's vendor master, not the portal's row. An approval that
// only moved the portal's copy left the supplier looking paid-to-new while
// SAP kept paying the old account — so SAP is asked first, and where it
// can't take the change yet the live row waits for a person to confirm it.
describe('bank-account change reaches SAP before the portal shows it', () => {
  let supplier;
  let admin;

  const asSupplier = (req) => req.set('Authorization', `Bearer ${supplier.token}`);
  const asAdmin = (req) => req.set('Authorization', `Bearer ${admin.token}`);
  const liveVendor = () => asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }));
  const sapLogs = () => asTenant(() => prisma.sapLog.findMany({ where: { vendorId: supplier.vendor.vendorId, name: 'ZVENDOR_BANK_UPDATE' } }));

  beforeEach(async () => {
    supplier = await registerVendor(app, {}, { onboarded: false });
    await onboardVendor(supplier.vendor.vendorId, { status: 'Approved' });
    await asTenant(() => prisma.vendor.updateMany({ where: { vendorId: supplier.vendor.vendorId }, data: { sapVendorCode: '1120250999' } }));
    admin = await createTenantUser({ role: 'client_admin' });
    await asSupplier(request(app).put('/api/vendors/profile')).send({ accountNumber: '99999999999', ifscCode: 'HDFC0000999' });
  });

  afterEach(() => invalidateSapAdapter());

  const useRealSapDriver = async () => {
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata', config: { baseUrl: 'http://127.0.0.1:9' } },
    }));
    invalidateSapAdapter();
  };

  it('applies the change once SAP accepts it, and logs the SAP call without the full account number', async () => {
    const pk = (await liveVendor()).pk;
    const res = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));

    expect(res.status).toBe(200);
    const after = await liveVendor();
    expect(after.accountNumber).toBe('99999999999');
    expect(after.pendingBankChange).toBeNull();

    const logs = await sapLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].payload).not.toContain('99999999999');

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.bank_change_approved' } }));
    expect(audit.meta.sapSync).toBe('synced');
  });

  it('when SAP has no endpoint for it yet, approval keeps the live account SAP still pays', async () => {
    await useRealSapDriver();
    const before = await liveVendor();

    const res = await asAdmin(request(app).put(`/api/vendors/${before.pk}/bank-change/approve`));

    expect(res.status).toBe(200);
    expect(res.body.awaitingSapConfirmation).toBe(true);
    const after = await liveVendor();
    expect(after.accountNumber).toBe(before.accountNumber);
    expect(after.pendingBankChange.accountNumber).toBe('99999999999');
    expect(after.pendingBankChange.sapApproval.approvedBy).toBeTruthy();

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.bank_change_approved' } }));
    expect(audit.meta.sapSync).toBe('manual_required');
  });

  it('applies an approval awaiting SAP once someone confirms it was made in SAP', async () => {
    await useRealSapDriver();
    const pk = (await liveVendor()).pk;
    await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));

    const res = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/confirm-sap`));

    expect(res.status).toBe(200);
    const after = await liveVendor();
    expect(after.accountNumber).toBe('99999999999');
    expect(after.ifscCode).toBe('HDFC0000999');
    expect(after.pendingBankChange).toBeNull();
    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.bank_change_sap_confirmed' } }));
    expect(audit.meta.new.accountNumber).toBe('99999999999');
  });

  it('refuses to confirm a change that was never approved, or to approve one twice', async () => {
    await useRealSapDriver();
    const pk = (await liveVendor()).pk;

    const early = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/confirm-sap`));
    expect(early.status).toBe(400);
    expect((await liveVendor()).accountNumber).not.toBe('99999999999');

    await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));
    const again = await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));
    expect(again.status).toBe(400);
    expect(again.body.reason).toBe('awaiting_sap_confirmation');
  });

  it('can still reject an approval that is waiting on SAP', async () => {
    await useRealSapDriver();
    const before = await liveVendor();
    await asAdmin(request(app).put(`/api/vendors/${before.pk}/bank-change/approve`));

    const res = await asAdmin(request(app).put(`/api/vendors/${before.pk}/bank-change/reject`)).send({ reason: 'XK02 change not made' });

    expect(res.status).toBe(200);
    const after = await liveVendor();
    expect(after.accountNumber).toBe(before.accountNumber);
    expect(after.pendingBankChange).toBeNull();
  });

  it('keeps payments blocked while the change waits on SAP', async () => {
    await useRealSapDriver();
    const pk = (await liveVendor()).pk;
    await asAdmin(request(app).put(`/api/vendors/${pk}/bank-change/approve`));
    const finance = await createTenantUser({ role: 'finance' });

    const res = await request(app).post('/api/payments')
      .set('Authorization', `Bearer ${finance.token}`)
      .send({ vendorId: supplier.vendor.vendorId, poId: 'PO-2026-0001', netAmount: 100, paymentDate: new Date().toISOString(), utrCode: 'UTRTEST0002' });

    expect(res.status).toBe(400);
  });

  it('is only available to someone who may approve suppliers', async () => {
    const buyer = await createTenantUser({ role: 'buyer' });
    const pk = (await liveVendor()).pk;
    const res = await request(app).put(`/api/vendors/${pk}/bank-change/confirm-sap`).set('Authorization', `Bearer ${buyer.token}`);
    expect(res.status).toBe(403);
  });
});
