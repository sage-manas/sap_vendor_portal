// Linking a supplier to a vendor master SAP already holds.
//
// A supplier who has traded with the buyer for years already has a vendor
// code in SAP and a history of RFQs, orders and invoices under it. Registering
// them the ordinary way ends in approveVendor calling VENDOR_CR, which mints a
// second vendor master with none of that history. The tenant can now name the
// existing code when it adds the supplier; the API confirms it against SAP's
// own documents, and approval adopts it instead of creating one.
const request = require('supertest');
const buildTestApp = require('./testApp');
const { createAdminUser, seedClient, asTenant } = require('./helpers');
const { prisma, rawPrisma } = require('../db/prisma');
const { invalidateSapAdapter } = require('../sap');
const { AUDIT_ACTIONS } = require('../config/auditActions');
const { VENDOR_STATUS } = require('../config/statuses');
const { lastMailTo, sentMails, clearMails } = require('../utils/mailer');

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const SAP_VENDOR = '1120250081';

const supplier = {
  companyName: 'Kaveri Forge & Fittings',
  gstin: '27AAECK4821M1ZA',
  pan: 'AAECK4821M',
  email: 'accounts@kaveriforge.example.com',
  phone: '+91 9823456710',
  address: 'Plot 14, MIDC Bhosari',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411026',
};

// The tenant's SAP connection is a precondition here, not the thing under
// test: the simulator answers ME48 with whatever documents it is configured
// to "discover", which stands in for SAP holding history for this vendor.
const sapHoldsDocuments = async (documents) => {
  await seedClient();
  await rawPrisma.sapConnection.create({
    data: {
      clientId: 'CLT-0001',
      environment: 'sandbox',
      driver: 'mock',
      config: { discoveries: { quotation: documents } },
    },
  });
  invalidateSapAdapter('CLT-0001');
};

const SAP_DOCUMENTS = [
  { documentNumber: '4500022828', documentType: 'Purchase Order', date: '20251112', currency: 'INR', purchasingOrg: 'SSDN' },
  { documentNumber: '6000000072', documentType: 'Quotation', date: '20251020', currency: 'INR', purchasingOrg: 'SSDN' },
];

const addSupplier = (token, body) => request(app).post('/api/vendors').set(auth(token)).send(body);

const vendorCreateCalls = () => asTenant(() => prisma.sapLog.count({ where: { name: 'BAPI_VENDOR_CREATE' } }));

// The supplier claims the account the tenant made, through the link it was
// emailed, exactly as a real one would.
const claimAccount = async (email) => {
  const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(lastMailTo(email).text)[1];
  const password = 'Kaveri@2026!Forge';
  await request(app).post('/api/auth/reset-password').set('x-client-slug', 'legacy')
    .send({ token, password }).expect(200);
  const login = await request(app).post('/api/auth/login').set('x-client-slug', 'legacy')
    .send({ vendorIdOrEmail: email, password });
  expect(login.status).toBe(200);
  return login.body.token;
};

beforeEach(() => clearMails());

describe('linking a supplier to an existing SAP vendor', () => {
  it('links, and approval adopts the SAP vendor instead of creating a second one', async () => {
    await sapHoldsDocuments(SAP_DOCUMENTS);
    const { token: admin } = await createAdminUser();

    const created = await addSupplier(admin, { ...supplier, sapVendorCode: SAP_VENDOR });
    expect(created.status).toBe(201);
    expect(created.body.sapLink).toEqual({ sapVendorCode: SAP_VENDOR, documents: 2 });
    expect(created.body.vendor).toMatchObject({ sapVendorCode: SAP_VENDOR, status: VENDOR_STATUS.DRAFT });

    const supplierToken = await claimAccount(supplier.email);
    const submitted = await request(app).post('/api/vendors/profile/submit').set(auth(supplierToken)).send({});
    expect(submitted.status).toBe(200);

    const { pk } = created.body.vendor;
    const approved = await request(app).put(`/api/vendors/${pk}/approve`).set(auth(admin)).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.vendor).toMatchObject({ status: VENDOR_STATUS.APPROVED, sapVendorCode: SAP_VENDOR });

    expect(await vendorCreateCalls()).toBe(0);
    const entry = await rawPrisma.auditLog.findFirst({ where: { action: AUDIT_ACTIONS.VENDOR_APPROVED } });
    expect(entry.meta).toMatchObject({ sapVendorCode: SAP_VENDOR, sapVendorMaster: 'linked' });
  });

  it('refuses a code SAP holds no documents for, and creates and emails nothing', async () => {
    await sapHoldsDocuments([]);
    const { token: admin } = await createAdminUser();

    const res = await addSupplier(admin, { ...supplier, sapVendorCode: '9999999999' });

    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('sap_vendor_not_found');
    expect(res.body.errors.sapVendorCode).toMatch(/9999999999/);
    expect(await asTenant(() => prisma.vendor.count({ where: { email: supplier.email } }))).toBe(0);
    expect(sentMails()).toHaveLength(0);
  });

  it('refuses a code already linked to another supplier in the workspace', async () => {
    await sapHoldsDocuments(SAP_DOCUMENTS);
    const { token: admin } = await createAdminUser();
    await addSupplier(admin, { ...supplier, sapVendorCode: SAP_VENDOR }).expect(201);

    const res = await addSupplier(admin, {
      ...supplier,
      companyName: 'Kaveri Duplicate',
      email: 'dup@kaveriforge.example.com',
      gstin: '27AAECK4822M1Z9',
      pan: 'AAECK4822M',
      sapVendorCode: SAP_VENDOR,
    });

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('sap_vendor_code_taken');
  });

  it('refuses a malformed code before asking SAP', async () => {
    const { token: admin } = await createAdminUser();

    const res = await addSupplier(admin, { ...supplier, sapVendorCode: 'not a code!' });

    expect(res.status).toBe(400);
    expect(res.body.errors.sapVendorCode).toMatch(/up to 10 letters or digits/);
  });

  it('treats an empty code as no link, so approval creates the vendor in SAP as before', async () => {
    const { token: admin } = await createAdminUser();

    const res = await addSupplier(admin, { ...supplier, sapVendorCode: '' });

    expect(res.status).toBe(201);
    expect(res.body.vendor.sapVendorCode).toBeFalsy();
    expect(res.body.sapLink).toBeUndefined();
  });

  // The code decides whose documents and payments a supplier sees. Only the
  // tenant may set it; a supplier naming its own could attach itself to
  // another vendor's ledger.
  it('never lets a supplier set its own SAP vendor code', async () => {
    await sapHoldsDocuments(SAP_DOCUMENTS);
    const { token: admin } = await createAdminUser();
    await addSupplier(admin, supplier).expect(201);
    const supplierToken = await claimAccount(supplier.email);

    const res = await request(app).put('/api/vendors/profile').set(auth(supplierToken)).send({ sapVendorCode: SAP_VENDOR });

    expect(res.status).toBe(400);
    const stored = await asTenant(() => prisma.vendor.findFirst({ where: { email: supplier.email } }));
    expect(stored.sapVendorCode).toBeFalsy();
  });

  it('still refuses to resubmit a registration that has been approved', async () => {
    await sapHoldsDocuments(SAP_DOCUMENTS);
    const { token: admin } = await createAdminUser();
    const created = await addSupplier(admin, { ...supplier, sapVendorCode: SAP_VENDOR }).expect(201);
    const supplierToken = await claimAccount(supplier.email);
    await request(app).post('/api/vendors/profile/submit').set(auth(supplierToken)).send({}).expect(200);
    await request(app).put(`/api/vendors/${created.body.vendor.pk}/approve`).set(auth(admin)).send({}).expect(200);

    const again = await request(app).post('/api/vendors/profile/submit').set(auth(supplierToken)).send({});

    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('already_approved');
  });
});
