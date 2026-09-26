const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma, rawPrisma } = require('../db/prisma');
const { withoutTenantScope } = require('../utils/tenantContext');
const { invalidateSapAdapter } = require('../sap');
const { registerVendor, createAdminUser, asTenant } = require('./helpers');

const app = buildTestApp();

// A rejection is the portal's own decision about a supplier SAP has never
// heard of — the vendor master is only created on approval. The s4_odata
// driver has no vendorReject endpoint (none exists in SAP), so it throws
// not_implemented; rejectVendor used to save the Rejected status first and
// then let that error escape, answering 501 with no audit entry and no
// decision email, on the driver every real tenant runs.
describe('rejecting a supplier on a tenant with real SAP', () => {
  beforeEach(async () => {
    await withoutTenantScope(() => rawPrisma.sapConnection.create({
      data: { clientId: 'CLT-0001', environment: 'sandbox', driver: 's4_odata', config: { baseUrl: 'http://127.0.0.1:9' } },
    }));
    invalidateSapAdapter();
  });

  afterEach(() => invalidateSapAdapter());

  it('succeeds, records the rejection and audits it', async () => {
    const { vendor } = await registerVendor(app);
    const { token } = await createAdminUser();

    const res = await request(app)
      .put(`/api/vendors/${vendor.pk}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'GST certificate does not match' });

    expect(res.status).toBe(200);
    const stored = await asTenant(() => prisma.vendor.findFirst({ where: { pk: vendor.pk } }));
    expect(stored.status).toBe('Rejected');
    expect(stored.rejectionReason).toBe('GST certificate does not match');

    const audit = await asTenant(() => prisma.auditLog.findFirst({ where: { action: 'vendor.rejected' } }));
    expect(audit).toBeTruthy();
    expect(audit.meta.reason).toBe('GST certificate does not match');
  });

  it('claims no SAP call it never made', async () => {
    const { vendor } = await registerVendor(app);
    const { token } = await createAdminUser();

    await request(app).put(`/api/vendors/${vendor.pk}/reject`).set('Authorization', `Bearer ${token}`).send({ reason: 'Duplicate' });

    const logs = await asTenant(() => prisma.sapLog.findMany({ where: { vendorId: vendor.vendorId, name: 'OData_VENDOR_REJECT' } }));
    expect(logs).toHaveLength(0);
  });
});
