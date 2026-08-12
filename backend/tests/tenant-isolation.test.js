// Cross-tenant isolation. Two tenants are seeded with an identical document in
// every tenant-scoped collection; tenant A must never read, update or delete
// tenant B's copy — and the API must answer 404, never 403, so it never
// confirms that another tenant's document exists.
//
// Every new tenant-scoped model gets a case in MODEL_CASES in the same commit
// that registers it with the tenant plugin.
const request = require('supertest');
const buildTestApp = require('./testApp');

const Vendor = require('../models/Vendor');
const RFQ = require('../models/RFQ');
const PurchaseOrder = require('../models/PurchaseOrder');
const ASN = require('../models/ASN');
const GRN = require('../models/GRN');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const ChatMessage = require('../models/ChatMessage');
const SapLog = require('../models/SapLog');
const DocumentModel = require('../models/Document');
const User = require('../models/User');
const Invitation = require('../models/Invitation');

const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { seedClient, signTokenFor } = require('./helpers');

const app = buildTestApp();

const A = { clientId: 'CLT-0001', slug: 'legacy' };
const B = { clientId: 'CLT-0002', slug: 'rival' };

const soon = () => new Date(Date.now() + 86400000);

// One representative document per model, identical in both tenants — same
// business IDs, which per-tenant uniqueness now permits.
const MODEL_CASES = [
  {
    name: 'Vendor',
    model: Vendor,
    doc: (t) => ({
      vendorId: `VND-${t}`, companyName: 'Shared Name Ltd',
      gstin: `27AABC${t}111F1Z5`, pan: `AABC${t}111F`, email: `vendor-${t}@example.com`,
    }),
    find: (t) => ({ vendorId: `VND-${t}` }),
    update: { $set: { companyName: 'Renamed by the wrong tenant' } },
    // Vendor is the one exception: vendorId/email/gstin are a login identity
    // and stay globally unique (ADR-0002).
    sharedBusinessId: false,
  },
  {
    name: 'RFQ',
    model: RFQ,
    doc: () => ({ id: 'RFQ-2026-001', description: 'Bearings', deadlineDate: soon(), items: [{ line: 10, materialCode: 'MAT-1', quantity: 5 }] }),
    find: () => ({ id: 'RFQ-2026-001' }),
    update: { $set: { status: 'Closed' } },
  },
  {
    name: 'PurchaseOrder',
    model: PurchaseOrder,
    doc: () => ({ id: 'PO-2026-0001', vendorId: 'VND-1', items: [{ line: 10, materialCode: 'MAT-1', quantity: 5, unitPrice: 10, netValue: 50 }] }),
    find: () => ({ id: 'PO-2026-0001' }),
    update: { $set: { status: 'Paid' } },
  },
  {
    name: 'ASN',
    model: ASN,
    doc: () => ({ id: 'ASN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', shipDate: new Date(), estimatedDeliveryDate: soon(), items: [{ line: 10, materialCode: 'MAT-1', shippedQuantity: 5 }] }),
    find: () => ({ id: 'ASN-000001' }),
    update: { $set: { status: 'Received' } },
  },
  {
    name: 'GRN',
    model: GRN,
    doc: () => ({ id: 'GRN-000001', poId: 'PO-2026-0001', asnId: 'ASN-000001', vendorId: 'VND-1', postingDate: new Date(), items: [{ line: 10, materialCode: 'MAT-1', receivedQuantity: 5, acceptedQuantity: 5 }] }),
    find: () => ({ id: 'GRN-000001' }),
    update: { $set: { invoiceSubmitted: true } },
  },
  {
    name: 'Invoice',
    model: Invoice,
    doc: () => ({ id: 'INV-000001', grnId: 'GRN-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', invoiceNumber: 'INV/1', invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118, items: [{ line: 10, materialCode: 'MAT-1', quantity: 5, unitPrice: 20, amount: 100 }] }),
    find: () => ({ id: 'INV-000001' }),
    update: { $set: { status: 'Cleared' } },
  },
  {
    name: 'Payment',
    model: Payment,
    doc: () => ({ id: 'PMT-000001', invoiceId: 'INV-000001', poId: 'PO-2026-0001', vendorId: 'VND-1', netAmount: 118, paymentDate: new Date(), utrCode: 'UTR123' }),
    find: () => ({ id: 'PMT-000001' }),
    update: { $set: { bankName: 'Wrong Bank' } },
  },
  {
    name: 'ChatMessage',
    model: ChatMessage,
    doc: () => ({ vendorId: 'VND-1', sender: 'Vendor', message: 'Where is my payment?' }),
    find: () => ({ vendorId: 'VND-1' }),
    update: { $set: { isRead: true } },
  },
  {
    name: 'SapLog',
    model: SapLog,
    doc: () => ({ vendorId: 'VND-1', type: 'BAPI', direction: 'OUTBOUND', name: 'BAPI_RFQ_CREATE', status: 'SUCCESS' }),
    find: () => ({ name: 'BAPI_RFQ_CREATE' }),
    update: { $set: { status: 'FAILED' } },
  },
  {
    name: 'User',
    model: User,
    doc: (t) => ({ email: `staff-${t}@example.com`, name: 'Staff Member', role: 'buyer', password: 'secret123' }),
    find: (t) => ({ email: `staff-${t}@example.com` }),
    update: { $set: { role: 'client_admin' } },
    // Like Vendor, a User's email is a login identity and stays globally
    // unique — the same address cannot exist in two tenants (ADR-0007).
    sharedBusinessId: false,
  },
  {
    name: 'Invitation',
    model: Invitation,
    doc: () => ({ email: 'invitee@example.com', role: 'buyer', tokenHash: 'a'.repeat(64), expiresAt: soon() }),
    find: () => ({ email: 'invitee@example.com' }),
    update: { $set: { status: 'Revoked' } },
  },
  {
    name: 'Document',
    model: DocumentModel,
    doc: () => ({ vendorId: 'VND-1', fileName: 'f.pdf', originalName: 'invoice.pdf', mimeType: 'application/pdf', size: 10, filePath: '/tmp/f.pdf' }),
    find: () => ({ fileName: 'f.pdf' }),
    update: { $set: { linkedTo: 'Invoice' } },
  },
];

beforeEach(async () => {
  await seedClient(A);
  await seedClient({ ...B, companyName: 'Rival Manufacturing' });
});

describe.each(MODEL_CASES)('cross-tenant isolation — $name', ({ model, doc, find, update, sharedBusinessId = true }) => {
  // Only tenant B holds a document. Anything tenant A can see, count, change
  // or delete is therefore a leak, with nothing of its own to mask it.
  const seedB = () => runWithTenant(B.clientId, () => model.create(doc('2')));

  it('read: tenant A cannot see tenant B\'s document', async () => {
    await seedB();
    await expect(runWithTenant(A.clientId, () => model.findOne(find('2')))).resolves.toBeNull();
    await expect(runWithTenant(A.clientId, () => model.find({}))).resolves.toHaveLength(0);
  });

  it('update: tenant A cannot modify tenant B\'s document', async () => {
    await seedB();
    const res = await runWithTenant(A.clientId, () => model.updateOne(find('2'), update));
    expect(res.matchedCount).toBe(0);

    const untouched = await runWithTenant(B.clientId, () => model.findOne(find('2')));
    expect(untouched).toBeTruthy();
    expect(untouched.clientId).toBe(B.clientId);
  });

  it('delete: tenant A cannot delete tenant B\'s document', async () => {
    await seedB();
    const res = await runWithTenant(A.clientId, () => model.deleteMany({}));
    expect(res.deletedCount).toBe(0);

    const survivors = await withoutTenantScope(() => model.find({}));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].clientId).toBe(B.clientId);
  });

  it('count: tenant A counts none of tenant B\'s documents', async () => {
    await seedB();
    await expect(runWithTenant(A.clientId, () => model.countDocuments({}))).resolves.toBe(0);
  });

  (sharedBusinessId ? it : it.skip)('both tenants can hold the same business ID', async () => {
    await seedB();
    await expect(runWithTenant(A.clientId, () => model.create(doc('2')))).resolves.toBeTruthy();
    await expect(withoutTenantScope(() => model.countDocuments({}))).resolves.toBe(2);
  });
});

// The same boundary as seen from outside, over HTTP: a wrong-tenant read must
// be indistinguishable from a document that does not exist.
describe('cross-tenant isolation over the API answers 404, not 403', () => {
  let tokenA;

  beforeEach(async () => {
    const vendorA = await runWithTenant(A.clientId, () => Vendor.create({
      vendorId: 'VND-A', companyName: 'Tenant A Supplies',
      gstin: '27AABCA2222F1Z5', pan: 'AABCA2222F', email: 'a@example.com',
    }));
    tokenA = signTokenFor(vendorA);

    // Tenant B's documents, invisible to A.
    await runWithTenant(B.clientId, async () => {
      await RFQ.create({ id: 'RFQ-2026-777', description: 'B only', deadlineDate: soon(), items: [{ line: 10, materialCode: 'MAT-B', quantity: 1 }] });
      await PurchaseOrder.create({ id: 'PO-2026-0777', vendorId: 'VND-B', items: [{ line: 10, materialCode: 'MAT-B', quantity: 1, unitPrice: 10, netValue: 10 }] });
      await GRN.create({ id: 'GRN-000777', poId: 'PO-2026-0777', asnId: 'ASN-000777', vendorId: 'VND-B', postingDate: new Date(), items: [{ line: 10, materialCode: 'MAT-B', receivedQuantity: 1, acceptedQuantity: 1 }] });
      await Invoice.create({ id: 'INV-000777', grnId: 'GRN-000777', poId: 'PO-2026-0777', vendorId: 'VND-B', invoiceNumber: 'B/1', invoiceDate: new Date(), subTotal: 10, taxAmount: 1.8, totalAmount: 11.8, items: [{ line: 10, materialCode: 'MAT-B', quantity: 1, unitPrice: 10, amount: 10 }] });
      await Payment.create({ id: 'PMT-000777', invoiceId: 'INV-000777', poId: 'PO-2026-0777', vendorId: 'VND-B', netAmount: 11.8, paymentDate: new Date(), utrCode: 'UTRB' });
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
    const vendorB = await runWithTenant(B.clientId, () => Vendor.create({
      vendorId: 'VND-B2', companyName: 'Tenant B Supplies',
      gstin: '29AABCB3333F1Z5', pan: 'AABCB3333F', email: 'b2@example.com',
    }));
    const tokenB = signTokenFor(vendorB);

    const res = await request(app).get('/api/rfqs?all=true').set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    const ids = (res.body.rfqs || res.body).map((r) => r.id);
    expect(ids).toContain('RFQ-2026-777'); // its own tenant's RFQ, and only that
    expect(ids).toHaveLength(1);
  });
});
