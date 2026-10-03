const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { registerVendor, onboardVendor, createTenantUser, asTenant } = require('./helpers');

// 2.4 — a supplier's bank account number and PAN were plain text in the
// database: in the vendors table, in a pending bank change, and in the PAN
// recorded on a TDS payment. A database dump, a read-only SQL account, or a
// backup copy therefore exposed every supplier's payout account. They are now
// encrypted per field (AES-256-GCM under MASTER_KEY, utils/secretBox.js) and
// decrypted as rows leave the data layer, so no caller changes.
//
// "What is in the table" is read with raw SQL on purpose: that is the thing
// under test, and the Prisma client would decrypt it for us.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const PAN = 'AABCB1234F';
const ACCOUNT = '123456789012';

const rawVendor = (vendorId) => withoutTenantScope(async () => {
  const [row] = await rawPrisma.$queryRaw`
    SELECT pan, "accountNumber", "ifscCode", "pendingBankChange" FROM vendors WHERE "vendorId" = ${vendorId}`;
  return row;
});

const withMasterKey = async (key, fn) => {
  const previous = process.env.MASTER_KEY;
  process.env.MASTER_KEY = key;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.MASTER_KEY; else process.env.MASTER_KEY = previous;
  }
};

describe('a supplier registered through the API', () => {
  let supplier;

  beforeEach(async () => {
    supplier = await registerVendor(app, {}, { onboarded: false });
  });

  it('has its PAN and account number encrypted in the table', async () => {
    const row = await rawVendor(supplier.vendor.vendorId);

    expect(row.pan).toMatch(/^v1:/);
    expect(row.accountNumber).toMatch(/^v1:/);
    expect(row.pan).not.toContain(PAN);
    expect(row.accountNumber).not.toContain(ACCOUNT);
  });

  it('leaves what is not secret readable, so the list and search screens still work', async () => {
    const row = await rawVendor(supplier.vendor.vendorId);
    expect(row.ifscCode).toBe('HDFC0000060');
  });

  it('still reads back in full to the supplier and to tenant staff', async () => {
    const own = await request(app).get('/api/vendors/profile').set(auth(supplier.token));
    expect(own.status).toBe(200);
    expect(own.body.pan).toBe(PAN);
    expect(own.body.accountNumber).toBe(ACCOUNT);

    const { token: staff } = await createTenantUser({ role: 'client_admin' });
    const pk = (await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }))).pk;
    const seen = await request(app).get(`/api/vendors/${pk}`).set(auth(staff));
    expect(seen.status).toBe(200);
    expect(seen.body.vendor.pan).toBe(PAN);
    expect(seen.body.vendor.accountNumber).toBe(ACCOUNT);
  });

  it('is decrypted when the row arrives through a relation, not only when it is read directly', async () => {
    const vendor = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }));
    await asTenant(() => prisma.purchaseOrder.create({
      data: { id: 'PO-2026-4001', vendorId: vendor.vendorId, vendorPk: vendor.pk, status: 'Acknowledged' },
    }));

    const po = await asTenant(() => prisma.purchaseOrder.findFirst({ where: { id: 'PO-2026-4001' }, include: { vendor: true } }));

    expect(po.vendor.pan).toBe(PAN);
    expect(po.vendor.accountNumber).toBe(ACCOUNT);
  });

  it('is not re-encrypted into something unreadable by an unrelated update', async () => {
    const res = await request(app).put('/api/vendors/profile').set(auth(supplier.token)).send({ tradeName: 'Acme Trading' });
    expect(res.status).toBe(200);

    const row = await rawVendor(supplier.vendor.vendorId);
    expect(row.accountNumber).toMatch(/^v1:/);
    const own = await request(app).get('/api/vendors/profile').set(auth(supplier.token));
    expect(own.body.accountNumber).toBe(ACCOUNT);
  });

  it('refuses to read the field, rather than return ciphertext or guess, when the key is wrong', async () => {
    await withMasterKey('a-different-master-key-entirely', async () => {
      // Prisma computes a result field when it is first read, so the refusal
      // comes on access: anything that serialises or copies the row hits it.
      const vendor = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }));
      expect(() => vendor.pan).toThrow();
      expect(() => JSON.stringify(vendor)).toThrow();
      expect(() => ({ ...vendor })).toThrow();
    });
  });
});

describe('a bank-detail change request', () => {
  let supplier;
  let admin;

  beforeEach(async () => {
    supplier = await registerVendor(app, {}, { onboarded: false });
    await onboardVendor(supplier.vendor.vendorId, { status: 'Approved' });
    admin = await createTenantUser({ role: 'client_admin' });
  });

  it('keeps the requested account number encrypted while it waits, and the live one once approved', async () => {
    const asked = await request(app).put('/api/vendors/profile').set(auth(supplier.token)).send({ accountNumber: '99999999999', ifscCode: 'XXXX0000999' });
    expect(asked.status).toBe(200);

    const waiting = await rawVendor(supplier.vendor.vendorId);
    expect(JSON.stringify(waiting.pendingBankChange)).not.toContain('99999999999');
    expect(waiting.pendingBankChange.accountNumber).toMatch(/^v1:/);
    // The live account is untouched, and still encrypted.
    expect(waiting.accountNumber).toMatch(/^v1:/);

    const pk = (await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: supplier.vendor.vendorId } }))).pk;
    const review = await request(app).get(`/api/vendors/${pk}`).set(auth(admin.token));
    expect(review.body.vendor.pendingBankChange.accountNumber).toBe('99999999999');

    const approved = await request(app).put(`/api/vendors/${pk}/bank-change/approve`).set(auth(admin.token));
    expect(approved.status).toBe(200);

    const live = await rawVendor(supplier.vendor.vendorId);
    expect(live.accountNumber).toMatch(/^v1:/);
    expect(live.accountNumber).not.toContain('99999999999');
    const after = await request(app).get(`/api/vendors/${pk}`).set(auth(admin.token));
    expect(after.body.vendor.accountNumber).toBe('99999999999');
  });
});

describe('the PAN a TDS payment records', () => {
  it('is encrypted in the table and readable through the data layer', async () => {
    await registerVendor(app, {}, { onboarded: false });
    await asTenant(() => prisma.payment.create({
      data: { id: 'PMT-ENC-0001', vendorId: 'vendor_test_001', netAmount: 100, paymentDate: new Date(), utrCode: 'UTR1', deducteePan: PAN },
    }));

    const [row] = await withoutTenantScope(() => rawPrisma.$queryRaw`SELECT "deducteePan" FROM payments WHERE id = 'PMT-ENC-0001'`);
    expect(row.deducteePan).toMatch(/^v1:/);

    const payment = await asTenant(() => prisma.payment.findFirst({ where: { id: 'PMT-ENC-0001' } }));
    expect(payment.deducteePan).toBe(PAN);
  });
});

describe('rows written before this change', () => {
  it('still read, because a plain value is returned as it is', async () => {
    const { vendor } = await registerVendor(app, {}, { onboarded: false });
    await withoutTenantScope(() => rawPrisma.$executeRaw`
      UPDATE vendors SET pan = ${PAN}, "accountNumber" = ${ACCOUNT} WHERE "vendorId" = ${vendor.vendorId}`);

    const read = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: vendor.vendorId } }));

    expect(read.pan).toBe(PAN);
    expect(read.accountNumber).toBe(ACCOUNT);
  });

  it('are encrypted by the migration script, which is safe to run again and reports what it did', async () => {
    const { vendor } = await registerVendor(app, {}, { onboarded: false });
    await withoutTenantScope(() => rawPrisma.$executeRaw`
      UPDATE vendors SET pan = ${PAN}, "accountNumber" = ${ACCOUNT},
        "pendingBankChange" = ${JSON.stringify({ accountNumber: '555566667777', ifscCode: 'HDFC0000001' })}::jsonb
      WHERE "vendorId" = ${vendor.vendorId}`);
    await asTenant(() => prisma.payment.create({
      data: { id: 'PMT-ENC-0002', vendorId: vendor.vendorId, netAmount: 100, paymentDate: new Date(), utrCode: 'UTR2' },
    }));
    await withoutTenantScope(() => rawPrisma.$executeRaw`UPDATE payments SET "deducteePan" = ${PAN} WHERE id = 'PMT-ENC-0002'`);

    const { encryptExistingFields } = require('../scripts/encrypt-existing-fields');

    const dry = await encryptExistingFields({ dryRun: true });
    expect(dry.wouldEncrypt).toBeGreaterThanOrEqual(4);
    expect((await rawVendor(vendor.vendorId)).pan).toBe(PAN);

    const first = await encryptExistingFields();
    expect(first.failed).toBe(0);
    const row = await rawVendor(vendor.vendorId);
    expect(row.pan).toMatch(/^v1:/);
    expect(row.accountNumber).toMatch(/^v1:/);
    expect(row.pendingBankChange.accountNumber).toMatch(/^v1:/);
    expect(row.pendingBankChange.ifscCode).toBe('HDFC0000001');
    const [payment] = await withoutTenantScope(() => rawPrisma.$queryRaw`SELECT "deducteePan" FROM payments WHERE id = 'PMT-ENC-0002'`);
    expect(payment.deducteePan).toMatch(/^v1:/);

    const read = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: vendor.vendorId } }));
    expect(read.pan).toBe(PAN);
    expect(read.accountNumber).toBe(ACCOUNT);
    expect(read.pendingBankChange.accountNumber).toBe('555566667777');

    const second = await encryptExistingFields();
    expect(second).toMatchObject({ encrypted: 0, failed: 0 });
    expect((await rawVendor(vendor.vendorId)).pan).toBe(row.pan);
  });
});

describe('rotating MASTER_KEY', () => {
  it('re-encrypts every field from the old key to the new one, and only those it can read', async () => {
    const { encryptExistingFields } = require('../scripts/encrypt-existing-fields');
    const OLD = 'the-old-master-key-for-this-test';
    const NEW = 'the-new-master-key-for-this-test';

    const { vendor } = await withMasterKey(OLD, () => registerVendor(app, {}, { onboarded: false }));
    const sealedUnderOld = await rawVendor(vendor.vendorId);

    await withMasterKey(NEW, async () => {
      // Under the new key the old blobs are unreadable until they are rotated.
      const stale = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: vendor.vendorId } }));
      expect(() => stale.pan).toThrow();

      // Without the old key it refuses, and reports, rather than guess.
      expect(await encryptExistingFields()).toMatchObject({ rotated: 0, failed: 1 });

      const dry = await encryptExistingFields({ dryRun: true, rotateFrom: OLD });
      expect(dry.wouldEncrypt).toBeGreaterThanOrEqual(2);
      expect((await rawVendor(vendor.vendorId)).pan).toBe(sealedUnderOld.pan);

      const done = await encryptExistingFields({ rotateFrom: OLD });
      expect(done).toMatchObject({ failed: 0 });
      expect(done.rotated).toBeGreaterThanOrEqual(2);

      const fresh = await asTenant(() => prisma.vendor.findFirst({ where: { vendorId: vendor.vendorId } }));
      expect(fresh.pan).toBe(PAN);
      expect(fresh.accountNumber).toBe(ACCOUNT);

      // Run again: everything is already current, nothing is touched.
      const again = await rawVendor(vendor.vendorId);
      expect(await encryptExistingFields({ rotateFrom: OLD })).toMatchObject({ rotated: 0, encrypted: 0, failed: 0 });
      expect((await rawVendor(vendor.vendorId)).pan).toBe(again.pan);
    });
  });
});

describe('looking a supplier up by an encrypted field', () => {
  it('is refused outright, because a match on ciphertext would silently find nothing', async () => {
    await expect(asTenant(() => prisma.vendor.findFirst({ where: { pan: PAN } }))).rejects.toThrow(/encrypted/i);
    await expect(asTenant(() => prisma.vendor.findMany({ where: { accountNumber: { contains: '1234' } } }))).rejects.toThrow(/encrypted/i);
  });

  it('does not stop the lookups that do work', async () => {
    await registerVendor(app, {}, { onboarded: false });
    const found = await asTenant(() => prisma.vendor.findFirst({ where: { gstin: '27AABCB1234F1Z5', status: { not: 'Rejected' } } }));
    expect(found.pan).toBe(PAN);
  });
});
