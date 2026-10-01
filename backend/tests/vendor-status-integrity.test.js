const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, onboardVendor, asTenant } = require('./helpers');

const app = buildTestApp();

// A supplier's status is the workflow's to set — submit, approve, reject —
// never the caller's. Both profile endpoints used to accept `status` from the
// request body: a Draft supplier could PUT itself to Approved and reach every
// onboarded-only route, and an anonymous self-registration could arrive
// already Approved without a buyer ever seeing it.
describe('supplier status is never caller-controlled', () => {
  const liveVendor = (vendorId) => asTenant(() => prisma.vendor.findFirst({ where: { vendorId } }));

  it('refuses a status in PUT /vendors/profile, and changes nothing', async () => {
    const supplier = await registerVendor(app);
    const res = await request(app)
      .put('/api/vendors/profile')
      .set('Authorization', `Bearer ${supplier.token}`)
      .send({ status: 'Approved', city: 'Pune' });

    expect(res.status).toBe(400);
    const vendor = await liveVendor(supplier.vendor.vendorId);
    expect(vendor.status).toBe('Draft');

    const pos = await request(app).get('/api/pos').set('Authorization', `Bearer ${supplier.token}`);
    expect(pos.status).toBe(403);
  });

  it('does not knock an approved supplier back to Draft, whatever a client sends', async () => {
    const supplier = await registerVendor(app, {}, { onboarded: true });
    const res = await request(app)
      .put('/api/vendors/profile')
      .set('Authorization', `Bearer ${supplier.token}`)
      .send({ status: 'Draft', city: 'Nashik' });

    expect(res.status).toBe(400);
    expect((await liveVendor(supplier.vendor.vendorId)).status).toBe('Approved');
  });
});

describe('supplier legal identity after approval', () => {
  const liveVendor = (vendorId) => asTenant(() => prisma.vendor.findFirst({ where: { vendorId } }));

  it('refuses a GSTIN, PAN, company name or email change from an approved supplier', async () => {
    const supplier = await registerVendor(app, {}, { onboarded: true });
    const before = await liveVendor(supplier.vendor.vendorId);

    const res = await request(app)
      .put('/api/vendors/profile')
      .set('Authorization', `Bearer ${supplier.token}`)
      .send({ gstin: '29ZZZZZ9999Z1Z9', companyName: 'Someone Else Pvt Ltd' });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('identity_locked');
    const after = await liveVendor(supplier.vendor.vendorId);
    expect(after.gstin).toBe(before.gstin);
    expect(after.companyName).toBe(before.companyName);
  });

  it('accepts a save that resends the unchanged identity', async () => {
    const supplier = await registerVendor(app, {}, { onboarded: true });
    const before = await liveVendor(supplier.vendor.vendorId);

    const res = await request(app)
      .put('/api/vendors/profile')
      .set('Authorization', `Bearer ${supplier.token}`)
      .send({ gstin: before.gstin.toLowerCase(), pan: before.pan, email: before.email, companyName: before.companyName, city: 'Thane' });

    expect(res.status).toBe(200);
  });

  it('voids a completed GSTIN/PAN verification when the GSTIN changes before approval', async () => {
    const supplier = await registerVendor(app);
    await onboardVendor(supplier.vendor.vendorId, { status: 'Pending Approval' });
    await asTenant(() => prisma.vendor.updateMany({
      where: { vendorId: supplier.vendor.vendorId },
      data: { gstinVerified: true, panVerified: true, verifiedAt: new Date() },
    }));

    const res = await request(app)
      .put('/api/vendors/profile')
      .set('Authorization', `Bearer ${supplier.token}`)
      .send({ gstin: '29ZZZZZ9999Z1Z9' });

    expect(res.status).toBe(200);
    const after = await liveVendor(supplier.vendor.vendorId);
    expect(after.gstinVerified).toBe(false);
    expect(after.verifiedAt).toBeNull();
  });
});
