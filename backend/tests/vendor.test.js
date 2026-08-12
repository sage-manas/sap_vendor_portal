const request = require('supertest');
const buildTestApp = require('./testApp');
const Vendor = require('../models/Vendor');
const { baseVendor, registerVendor, createAdminUser, asTenant } = require('./helpers');

const app = buildTestApp();

describe('GET /api/vendors/profile', () => {
  it('returns the authenticated vendor profile with nested bankDetails', async () => {
    const { token } = await registerVendor(app);
    const res = await request(app)
      .get('/api/vendors/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.vendorId).toBe(baseVendor.vendorId);
    expect(res.body.bankDetails).toMatchObject({
      bankName: baseVendor.bankName,
      ifscCode: baseVendor.ifscCode,
      accountType: 'Current'
    });
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await request(app).get('/api/vendors/profile');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/vendors/profile', () => {
  it('creates a profile and flattens nested legacy address/bankDetails', async () => {
    const res = await request(app).post('/api/vendors/profile').send({
      vendorId: 'vendor_nested_1',
      companyName: 'Nested Corp Ltd',
      gstin: '29AABCN9876Q1Z2',
      pan: 'AABCN9876Q',
      email: 'nested@example.com',
      address: { street: '5 Brigade Rd', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      bankDetails: { bankName: 'ICICI', accountNumber: '999888777666', ifscCode: 'ICIC0000012', accountHolderName: 'Nested Corp Ltd', branch: 'MG Road' }
    });

    expect(res.status).toBe(201);
    expect(res.body.city).toBe('Bengaluru');
    expect(res.body.postalCode).toBe('560001');
    expect(res.body.bankDetails.bankName).toBe('ICICI');
    expect(res.body.bankDetails.accountHolderName).toBe('Nested Corp Ltd');
    expect(res.body.status).toBe('Draft');
  });

  it('rejects a duplicate profile with 409', async () => {
    await registerVendor(app);
    const res = await request(app).post('/api/vendors/profile').send({
      vendorId: baseVendor.vendorId,
      companyName: baseVendor.companyName,
      gstin: baseVendor.gstin,
      pan: baseVendor.pan,
      email: baseVendor.email
    });
    expect(res.status).toBe(409);
  });

  it('rejects missing required fields with 400', async () => {
    const res = await request(app).post('/api/vendors/profile').send({ vendorId: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/vendors/profile', () => {
  it('updates fields but never vendorId', async () => {
    const { token } = await registerVendor(app);
    const res = await request(app)
      .put('/api/vendors/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ companyName: 'Acme Renamed Ltd', city: 'Mumbai', vendorId: 'hacked_id' });

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe('Acme Renamed Ltd');
    expect(res.body.city).toBe('Mumbai');
    expect(res.body.vendorId).toBe(baseVendor.vendorId);
  });
});

describe('registration approval flow', () => {
  it('submit moves status to Pending Approval', async () => {
    const { token } = await registerVendor(app);
    const res = await request(app)
      .post('/api/vendors/profile/submit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.vendor.status).toBe('Pending Approval');
    expect(res.body.vendor.submittedAt).toBeTruthy();
  });

  it('admin approve sets Approved and assigns a sapVendorCode', async () => {
    const { vendor } = await registerVendor(app);
    const { token: adminToken } = await createAdminUser();
    const res = await request(app)
      .put(`/api/vendors/${vendor._id}/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.vendor.status).toBe('Approved');
    expect(res.body.vendor.sapVendorCode).toMatch(/^VND-\d{5}$/);
  });

  it('admin reject requires a reason', async () => {
    const { vendor } = await registerVendor(app);
    const { token: adminToken } = await createAdminUser();

    const noReason = await request(app)
      .put(`/api/vendors/${vendor._id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(noReason.status).toBe(400);

    const rejected = await request(app)
      .put(`/api/vendors/${vendor._id}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Incomplete documents' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.vendor.status).toBe('Rejected');
    expect(rejected.body.vendor.rejectionReason).toBe('Incomplete documents');
  });

  it('a supplier gets 403 from all three directory endpoints', async () => {
    const { token, vendor } = await registerVendor(app);

    const list = await request(app)
      .get('/api/vendors')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(403);

    const approve = await request(app)
      .put(`/api/vendors/${vendor._id}/approve`)
      .set('Authorization', `Bearer ${token}`);
    expect(approve.status).toBe(403);

    const reject = await request(app)
      .put(`/api/vendors/${vendor._id}/reject`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Some reason' });
    expect(reject.status).toBe(403);
  });
});

describe('GET /api/vendors (admin list)', () => {
  it('filters by status and paginates', async () => {
    await registerVendor(app);
    const { token: adminToken } = await createAdminUser();
    await asTenant(() => Vendor.create({
      vendorId: 'vendor_approved_1',
      companyName: 'Approved Co Ltd',
      gstin: '07AABCA1111B1Z9',
      pan: 'AABCA1111B',
      email: 'approved@example.com',
      status: 'Approved'
    }));

    const res = await request(app)
      .get('/api/vendors?status=Approved')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.vendors).toHaveLength(1);
    expect(res.body.vendors[0].status).toBe('Approved');
    expect(res.body.pagination.total).toBe(1);
  });
});

// ADMIN_BOOTSTRAP_EMAILS is gone (ADR-0009). Self-registration is a supplier
// door and nothing else — staff arrive by invitation.
describe('self-registration cannot mint a staff account', () => {
  it('always assigns the vendor role, whatever the request asks for', async () => {
    const { vendor } = await registerVendor(app, {
      vendorId: 'vendor_bootstrap_1',
      email: 'owner@example.com',
      role: 'client_admin'
    });
    expect(vendor.role).toBe('vendor');
  });
});
