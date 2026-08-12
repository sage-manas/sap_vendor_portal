const request = require('supertest');
const jwt = require('jsonwebtoken');
const Vendor = require('../models/Vendor');
const Client = require('../models/Client');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { planeOf } = require('../config/roles');

const baseVendor = {
  vendorId: 'vendor_test_001',
  password: 'secret123',
  companyName: 'Acme Industries Pvt Ltd',
  gstin: '27AABCB1234F1Z5',
  pan: 'AABCB1234F',
  email: 'acme@example.com',
  phone: '9876543210',
  address: '12 MG Road',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  bankName: 'HDFC Bank',
  accountNumber: '123456789012',
  ifscCode: 'HDFC0000060',
  accountName: 'Acme Industries Pvt Ltd',
  bankBranch: 'Pune Main'
};

// Every test needs at least one tenant to exist: registration resolves the
// workspace by slug before it will create anything.
const seedClient = async ({ clientId = 'CLT-0001', slug = 'legacy', companyName = 'Legacy' } = {}) =>
  withoutTenantScope(async () => {
    const existing = await Client.findOne({ clientId });
    if (existing) return existing;
    return Client.create({ clientId, slug, companyName, status: 'Active' });
  });

// Registers a vendor through the real API and returns { token, vendor }.
// `clientSlug` picks the workspace (see utils/resolveClient.js).
const registerVendor = async (app, overrides = {}, { clientSlug = 'legacy' } = {}) => {
  await seedClient({ slug: clientSlug, clientId: overrides.clientId || 'CLT-0001' });
  const payload = { ...baseVendor, ...overrides };
  delete payload.clientId;
  const res = await request(app)
    .post('/api/auth/register')
    .set('x-client-slug', clientSlug)
    .send(payload);
  if (res.status !== 201) {
    throw new Error(`Test vendor registration failed: ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, vendor: res.body.vendor, payload };
};

const signTokenFor = (vendor) => jwt.sign(
  {
    id: vendor._id,
    vendorId: vendor.vendorId,
    email: vendor.email,
    clientId: vendor.clientId,
    roleScope: planeOf(vendor.role),
  },
  process.env.JWT_SECRET || 'secret',
  { expiresIn: '30d' }
);

// Creates a vendor with role 'admin' directly via the model (the register
// endpoint intentionally never accepts a client-supplied role) and signs a
// token for it the same way auth.controller.js's generateToken does.
const createAdminVendor = async (overrides = {}) => {
  const { clientId = 'CLT-0001', ...rest } = overrides;
  await seedClient({ clientId, slug: clientId === 'CLT-0001' ? 'legacy' : clientId.toLowerCase() });
  const vendor = await runWithTenant(clientId, () => Vendor.create({
    vendorId: 'vendor_admin_001',
    companyName: 'Portal Admin Ops',
    gstin: '27AABCA9999F1Z1',
    pan: 'AABCA9999F',
    email: 'admin@example.com',
    role: 'admin',
    ...rest
  }));
  return { token: signTokenFor(vendor), vendor };
};

// Test code that touches models directly is subject to the same rule as
// application code: bind a tenant, or the query throws.
const asTenant = (fn, clientId = 'CLT-0001') => runWithTenant(clientId, fn);

module.exports = { baseVendor, registerVendor, createAdminVendor, seedClient, signTokenFor, asTenant };
