// Cross-tenant isolation. Two tenants are seeded with an identical document in
// every tenant-scoped collection; tenant A must never read, update or delete
// tenant B's copy — and the API must answer 404, never 403, so it never
// confirms that another tenant's document exists.
//
// Every new tenant-scoped model gets a case in MODEL_CASES in the same commit
// that registers it with the tenant extension (backend/db/tenantExtension.js).
const request = require('supertest');
const buildTestApp = require('./testApp');

const { prisma, rawPrisma } = require('../db/prisma');
const { hashPassword } = require('../db/credentials');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { seedClient, signTokenFor } = require('./helpers');

const app = buildTestApp();

const A = { clientId: 'CLT-0001', slug: 'legacy' };
const B = { clientId: 'CLT-0002', slug: 'rival' };

const soon = () => new Date(Date.now() + 86400000);

// Thin adapter over the Prisma client giving each case the same five
// operations the old Mongoose-model-driven table used, so the describe.each
// body below stays close to its original shape.
const adapterFor = (clientProp) => ({
  findOne: (where) => prisma[clientProp].findFirst({ where }),
  find: (where) => prisma[clientProp].findMany({ where }),
  findAllUnscoped: (where) => rawPrisma[clientProp].findMany({ where }),
  updateOne: async (where, data) => {
    const result = await prisma[clientProp].updateMany({ where, data });
    return { matchedCount: result.count };
  },
  deleteMany: async (where) => {
    const result = await prisma[clientProp].deleteMany({ where });
    return { deletedCount: result.count };
  },
  countDocuments: (where) => prisma[clientProp].count({ where }),
});

// One representative document per model, identical in both tenants — same
// business IDs, which per-tenant uniqueness now permits. `create(t)` builds
// whatever FK prerequisites a model now requires (soft string references in
// Mongoose became real foreign keys — see prisma/schema.prisma) before
// creating the row itself, and returns it.
const MODEL_CASES = [
  {
    name: 'Vendor',
    adapter: adapterFor('vendor'),
    create: (t) => prisma.vendor.create({ data: {
      vendorId: `VND-${t}`, companyName: 'Shared Name Ltd',
      gstin: `27AABC${t}111F1Z5`, pan: `AABC${t}111F`, email: `vendor-${t}@example.com`,
    } }),
    find: (t) => ({ vendorId: `VND-${t}` }),
    update: { companyName: 'Renamed by the wrong tenant' },
    // Vendor is the one exception: vendorId/email/gstin are a login identity
    // and stay globally unique (ADR-0002).
    sharedBusinessId: false,
  },
  {
    name: 'RFQ',
    adapter: adapterFor('rFQ'),
    create: () => prisma.rFQ.create({ data: { id: 'RFQ-2026-001', description: 'Bearings', deadlineDate: soon() } }),
    find: () => ({ id: 'RFQ-2026-001' }),
    update: { status: 'Closed' },
  },
  {
    name: 'PurchaseOrder',
    adapter: adapterFor('purchaseOrder'),
    create: () => prisma.purchaseOrder.create({ data: { id: 'PO-2026-0001', vendorId: 'VND-1' } }),
    find: () => ({ id: 'PO-2026-0001' }),
    update: { status: 'Paid' },
  },
  {
    name: 'ASN',
    adapter: adapterFor('aSN'),
    create: async () => {
      await prisma.purchaseOrder.create({ data: { id: 'PO-2026-0001', vendorId: 'VND-1' } });
      return prisma.aSN.create({ data: {
        id: 'ASN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1',
        shipDate: new Date(), estimatedDeliveryDate: soon(),
      } });
    },
    find: () => ({ id: 'ASN-000001' }),
    update: { status: 'Received' },
  },
  {
    name: 'GRN',
    adapter: adapterFor('gRN'),
    create: async () => {
      await prisma.purchaseOrder.create({ data: { id: 'PO-2026-0001', vendorId: 'VND-1' } });
      await prisma.aSN.create({ data: { id: 'ASN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', shipDate: new Date(), estimatedDeliveryDate: soon() } });
      return prisma.gRN.create({ data: { id: 'GRN-000001', poId: 'PO-2026-0001', asnId: 'ASN-000001', vendorId: 'VND-1', postingDate: new Date() } });
    },
    find: () => ({ id: 'GRN-000001' }),
    update: { invoiceSubmitted: true },
  },
  {
    name: 'Invoice',
    adapter: adapterFor('invoice'),
    create: async () => {
      await prisma.purchaseOrder.create({ data: { id: 'PO-2026-0001', vendorId: 'VND-1' } });
      await prisma.aSN.create({ data: { id: 'ASN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', shipDate: new Date(), estimatedDeliveryDate: soon() } });
      await prisma.gRN.create({ data: { id: 'GRN-000001', poId: 'PO-2026-0001', asnId: 'ASN-000001', vendorId: 'VND-1', postingDate: new Date() } });
      return prisma.invoice.create({ data: {
        id: 'INV-000001', grnId: 'GRN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1',
        invoiceNumber: 'INV/1', invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118,
      } });
    },
    find: () => ({ id: 'INV-000001' }),
    update: { status: 'Cleared' },
  },
  {
    name: 'Payment',
    adapter: adapterFor('payment'),
    create: async () => {
      await prisma.purchaseOrder.create({ data: { id: 'PO-2026-0001', vendorId: 'VND-1' } });
      await prisma.aSN.create({ data: { id: 'ASN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', shipDate: new Date(), estimatedDeliveryDate: soon() } });
      await prisma.gRN.create({ data: { id: 'GRN-000001', poId: 'PO-2026-0001', asnId: 'ASN-000001', vendorId: 'VND-1', postingDate: new Date() } });
      await prisma.invoice.create({ data: { id: 'INV-000001', grnId: 'GRN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', invoiceNumber: 'INV/1', invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118 } });
      return prisma.payment.create({ data: { id: 'PMT-000001', invoiceId: 'INV-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', netAmount: 118, paymentDate: new Date(), utrCode: 'UTR123' } });
    },
    find: () => ({ id: 'PMT-000001' }),
    update: { bankName: 'Wrong Bank' },
  },
  {
    name: 'ChatMessage',
    adapter: adapterFor('chatMessage'),
    create: () => prisma.chatMessage.create({ data: { vendorId: 'VND-1', sender: 'Vendor', message: 'Where is my payment?' } }),
    find: () => ({ vendorId: 'VND-1' }),
    update: { isRead: true },
  },
  {
    name: 'SapLog',
    adapter: adapterFor('sapLog'),
    create: () => prisma.sapLog.create({ data: { vendorId: 'VND-1', type: 'BAPI', direction: 'OUTBOUND', name: 'BAPI_RFQ_CREATE', status: 'SUCCESS' } }),
    find: () => ({ name: 'BAPI_RFQ_CREATE' }),
    update: { status: 'FAILED' },
  },
  {
    name: 'User',
    adapter: adapterFor('user'),
    create: async (t) => {
      const { password, passwordChangedAt } = await hashPassword('secret123');
      return prisma.user.create({ data: { email: `staff-${t}@example.com`, name: 'Staff Member', role: 'buyer', password, passwordChangedAt } });
    },
    find: (t) => ({ email: `staff-${t}@example.com` }),
    update: { role: 'client_admin' },
    // Like Vendor, a User's email is a login identity and stays globally
    // unique — the same address cannot exist in two tenants (ADR-0007).
    sharedBusinessId: false,
  },
  {
    name: 'Invitation',
    adapter: adapterFor('invitation'),
    create: () => prisma.invitation.create({ data: { email: 'invitee@example.com', role: 'buyer', tokenHash: 'a'.repeat(64), expiresAt: soon() } }),
    find: () => ({ email: 'invitee@example.com' }),
    update: { status: 'Revoked' },
  },
  {
    name: 'Document',
    adapter: adapterFor('document'),
    create: () => prisma.document.create({ data: { vendorId: 'VND-1', fileName: 'f.pdf', originalName: 'invoice.pdf', mimeType: 'application/pdf', size: 10, filePath: '/tmp/f.pdf' } }),
    find: () => ({ fileName: 'f.pdf' }),
    update: { linkedTo: 'Invoice' },
  },
];

beforeEach(async () => {
  await seedClient(A);
  await seedClient({ ...B, companyName: 'Rival Manufacturing' });
});

describe.each(MODEL_CASES)('cross-tenant isolation — $name', ({ adapter, create, find, update, sharedBusinessId = true }) => {
  // Only tenant B holds a document. Anything tenant A can see, count, change
  // or delete is therefore a leak, with nothing of its own to mask it.
  const seedB = () => runWithTenant(B.clientId, () => create('2'));

  it('read: tenant A cannot see tenant B\'s document', async () => {
    await seedB();
    await expect(runWithTenant(A.clientId, () => adapter.findOne(find('2')))).resolves.toBeNull();
    await expect(runWithTenant(A.clientId, () => adapter.find({}))).resolves.toHaveLength(0);
  });

  it('update: tenant A cannot modify tenant B\'s document', async () => {
    await seedB();
    const res = await runWithTenant(A.clientId, () => adapter.updateOne(find('2'), update));
    expect(res.matchedCount).toBe(0);

    const untouched = await runWithTenant(B.clientId, () => adapter.findOne(find('2')));
    expect(untouched).toBeTruthy();
    expect(untouched.clientId).toBe(B.clientId);
  });

  it('delete: tenant A cannot delete tenant B\'s document', async () => {
    await seedB();
    const res = await runWithTenant(A.clientId, () => adapter.deleteMany({}));
    expect(res.deletedCount).toBe(0);

    const survivors = await withoutTenantScope(() => adapter.findAllUnscoped({}));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].clientId).toBe(B.clientId);
  });

  it('count: tenant A counts none of tenant B\'s documents', async () => {
    await seedB();
    await expect(runWithTenant(A.clientId, () => adapter.countDocuments({}))).resolves.toBe(0);
  });

  (sharedBusinessId ? it : it.skip)('both tenants can hold the same business ID', async () => {
    await seedB();
    await expect(runWithTenant(A.clientId, () => create('2'))).resolves.toBeTruthy();
    await expect(withoutTenantScope(() => adapter.findAllUnscoped({}))).resolves.toHaveLength(2);
  });
});

// The same boundary as seen from outside, over HTTP: a wrong-tenant read must
// be indistinguishable from a document that does not exist.
describe('cross-tenant isolation over the API answers 404, not 403', () => {
  let tokenA;

  beforeEach(async () => {
    const vendorA = await runWithTenant(A.clientId, () => prisma.vendor.create({ data: {
      vendorId: 'VND-A', companyName: 'Tenant A Supplies',
      gstin: '27AABCA2222F1Z5', pan: 'AABCA2222F', email: 'a@example.com',
      // Onboarded: this suite is about tenancy, and the transacting modules are
      // shut to a supplier who has not submitted (middleware/requireOnboarded).
      status: 'Approved',
    } }));
    tokenA = signTokenFor(vendorA);

    // Tenant B's documents, invisible to A.
    await runWithTenant(B.clientId, async () => {
      await prisma.rFQ.create({ data: { id: 'RFQ-2026-777', description: 'B only', deadlineDate: soon() } });
      await prisma.purchaseOrder.create({ data: { id: 'PO-2026-0777', vendorId: 'VND-B' } });
      await prisma.aSN.create({ data: { id: 'ASN-000777', poId: 'PO-2026-0777', vendorId: 'VND-B', shipDate: new Date(), estimatedDeliveryDate: soon() } });
      await prisma.gRN.create({ data: { id: 'GRN-000777', poId: 'PO-2026-0777', asnId: 'ASN-000777', vendorId: 'VND-B', postingDate: new Date() } });
      await prisma.invoice.create({ data: { id: 'INV-000777', grnId: 'GRN-000777', poId: 'PO-2026-0777', vendorId: 'VND-B', invoiceNumber: 'B/1', invoiceDate: new Date(), subTotal: 10, taxAmount: 1.8, totalAmount: 11.8 } });
      await prisma.payment.create({ data: { id: 'PMT-000777', invoiceId: 'INV-000777', poId: 'PO-2026-0777', vendorId: 'VND-B', netAmount: 11.8, paymentDate: new Date(), utrCode: 'UTRB' } });
    });
  });

  it.each([
    ['RFQ',      '/api/rfqs/RFQ-2026-777'],
    ['PO',       '/api/pos/PO-2026-0777'],
    ['GRN',      '/api/grns/GRN-000777'],
    ['Invoice',  '/api/invoices/INV-000777'],
    ['Payment',  '/api/payments/PMT-000777'],
  ])('GET %s belonging to another tenant → 404', async (_label, path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('list endpoints never include another tenant\'s rows', async () => {
    const res = await request(app).get('/api/rfqs?all=true').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const ids = (res.body.rfqs || res.body).map((r) => r.id);
    expect(ids).not.toContain('RFQ-2026-777');
  });

  it('a token minted for tenant B cannot act as tenant A', async () => {
    const vendorB = await runWithTenant(B.clientId, async () => {
      const created = await prisma.vendor.create({ data: {
        vendorId: 'VND-B2', companyName: 'Tenant B Supplies',
        gstin: '29AABCB3333F1Z5', pan: 'AABCB3333F', email: 'b2@example.com',
        status: 'Approved',
      } });
      // Invited to its own tenant's RFQ, so "sees exactly one" is a statement
      // about tenancy rather than about the supplier scope filter. `?all=true`
      // is no longer a supplier affordance — it is staff-only.
      const rfq = await prisma.rFQ.findFirst({ where: { id: 'RFQ-2026-777' } });
      await prisma.rfqInvitedVendor.create({ data: { rfqPk: rfq.pk, vendorExtId: 'VND-B2', name: 'Tenant B Supplies' } });
      return created;
    });
    const tokenB = signTokenFor(vendorB);

    const res = await request(app).get('/api/rfqs').set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const ids = (res.body.rfqs || res.body).map((r) => r.id);
    expect(ids).toContain('RFQ-2026-777'); // its own tenant's RFQ, and only that
    expect(ids).toHaveLength(1);
  });
});
