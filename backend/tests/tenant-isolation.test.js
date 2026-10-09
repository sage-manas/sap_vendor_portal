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
const { runWithTenant, withoutTenantScope, getTenantId } = require('../utils/tenantContext');
const { TENANT_SCOPED_MODELS } = require('../db/tenantExtension');
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
// Parent chains for the line-item cases at the end of MODEL_CASES. The
// document-level cases inline their own; a child row needs the whole chain
// above it, and repeating that eleven times would bury the one line per
// case that actually differs. These go through `prisma`, not `rawPrisma`,
// so each parent is stamped with whichever tenant the caller bound.
const seedRfqRow = () => prisma.rFQ.create({ data: { id: 'RFQ-2026-001', description: 'Bearings', deadlineDate: soon() } });

const seedBidRow = async (t) => {
  const rfq = await seedRfqRow();
  return prisma.rfqBid.create({ data: { rfqPk: rfq.pk, vendorId: `VND-${t}` } });
};

const seedPoRow = () => prisma.purchaseOrder.create({ data: { id: 'PO-2026-0001', vendorId: 'VND-1' } });

const seedPoItemRow = async (t) => {
  const po = await seedPoRow();
  return prisma.purchaseOrderItem.create({ data: {
    poPk: po.pk, line: 10, materialCode: `MAT-${t}`, quantity: 5, unitPrice: 10, netValue: 50,
  } });
};

const seedAsnRow = async () => {
  const po = await seedPoRow();
  return prisma.aSN.create({ data: {
    id: 'ASN-000001', poId: po.id, vendorId: 'VND-1', shipDate: new Date(), estimatedDeliveryDate: soon(),
  } });
};

const seedGrnRow = async () => {
  const asn = await seedAsnRow();
  return prisma.gRN.create({ data: {
    id: 'GRN-000001', poId: asn.poId, asnId: asn.id, vendorId: 'VND-1', postingDate: new Date(),
  } });
};

const seedInvoiceRow = async () => {
  const grn = await seedGrnRow();
  return prisma.invoice.create({ data: {
    id: 'INV-000001', grnId: grn.id, poId: grn.poId, vendorId: 'VND-1',
    invoiceNumber: 'INV/1', invoiceDate: new Date(), subTotal: 100, taxAmount: 18, totalAmount: 118,
  } });
};

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
    // Vendor is the one exception: vendorId/email are a login identity and
    // stay globally unique (ADR-0002); gstin moved to per-tenant uniqueness
    // (ADR-0039) but this case still gives each tenant a distinct gstin, so
    // sharedBusinessId stays false here too.
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
      return prisma.payment.create({
        data: {
          id: 'PMT-000001', vendorId: 'VND-1', netAmount: 118, paymentDate: new Date(), utrCode: 'UTR123',
          items: { create: [{ clientId: getTenantId(), invoiceId: 'INV-000001', poId: 'PO-2026-0001', netAmount: 118 }] },
        },
      });
    },
    find: () => ({ id: 'PMT-000001' }),
    update: { bankName: 'Wrong Bank' },
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
  // ---------------------------------------------------------------------
  // Line items and other child rows. Each carries its own `clientId`
  // column and is registered with the tenant extension in its own right
  // (db/tenantExtension.js), so each is scoped directly rather than through
  // a join on its parent -- which is exactly why each needs its own case:
  // the parent being isolated says nothing about the child.
  //
  // RfqBid and RfqBidUnitPrice are the most sensitive rows in the schema --
  // one supplier's sealed bid and its per-line pricing, which a rival in
  // any tenant must never read. Both were uncovered here until this block
  // was added.
  // ---------------------------------------------------------------------
  {
    name: 'RfqItem',
    adapter: adapterFor('rfqItem'),
    create: async (t) => {
      const rfq = await seedRfqRow();
      return prisma.rfqItem.create({ data: {
        rfqPk: rfq.pk, line: 10, materialCode: `MAT-${t}`, quantity: 5, targetPrice: 12,
      } });
    },
    find: (t) => ({ materialCode: `MAT-${t}` }),
    update: { description: 'Renamed by the wrong tenant' },
  },
  {
    name: 'RfqBid',
    adapter: adapterFor('rfqBid'),
    create: async (t) => {
      const rfq = await seedRfqRow();
      return prisma.rfqBid.create({ data: {
        rfqPk: rfq.pk, vendorId: `VND-${t}`, vendorName: 'Sealed Bidder', gstRate: '18%', freight: 500,
      } });
    },
    find: (t) => ({ vendorId: `VND-${t}` }),
    update: { remarks: 'Tampered with by the wrong tenant' },
  },
  {
    name: 'RfqBidUnitPrice',
    adapter: adapterFor('rfqBidUnitPrice'),
    create: async (t) => {
      const bid = await seedBidRow(t);
      return prisma.rfqBidUnitPrice.create({ data: { bidPk: bid.pk, lineNumber: 10, price: 11.5 } });
    },
    // Keyed on the price itself: a rival reading this row is the leak that
    // matters, so the selector is the commercially sensitive value.
    find: () => ({ price: 11.5 }),
    update: { price: 1 },
  },
  {
    name: 'RfqBidDocument',
    adapter: adapterFor('rfqBidDocument'),
    create: async (t) => {
      const bid = await seedBidRow(t);
      return prisma.rfqBidDocument.create({ data: {
        bidPk: bid.pk, documentId: `DOC-${t}`, originalName: 'quotation.pdf', url: '/tmp/quotation.pdf',
      } });
    },
    find: (t) => ({ documentId: `DOC-${t}` }),
    update: { originalName: 'swapped.pdf' },
  },
  {
    name: 'RfqInvitedVendor',
    adapter: adapterFor('rfqInvitedVendor'),
    create: async (t) => {
      const rfq = await seedRfqRow();
      return prisma.rfqInvitedVendor.create({ data: {
        rfqPk: rfq.pk, vendorExtId: `VND-${t}`, name: 'Invited Supplier', rating: 95,
      } });
    },
    find: (t) => ({ vendorExtId: `VND-${t}` }),
    // The invitee list is what makes a tender sealed (ADR-0037): writing to
    // another tenant's would be an uninvited vendor inviting itself.
    update: { status: 'Revoked' },
  },
  {
    name: 'PurchaseOrderItem',
    adapter: adapterFor('purchaseOrderItem'),
    create: async (t) => {
      const po = await seedPoRow();
      return prisma.purchaseOrderItem.create({ data: {
        poPk: po.pk, line: 10, materialCode: `MAT-${t}`, quantity: 5, unitPrice: 10, netValue: 50,
      } });
    },
    find: (t) => ({ materialCode: `MAT-${t}` }),
    update: { unitPrice: 1 },
  },
  {
    name: 'InvoicePlan',
    adapter: adapterFor('invoicePlan'),
    create: async (t) => {
      const item = await seedPoItemRow(t);
      return prisma.invoicePlan.create({ data: {
        itemPk: item.pk, enabled: true, planNumber: `PLAN-${t}`, periodicAmount: 1000,
      } });
    },
    find: (t) => ({ planNumber: `PLAN-${t}` }),
    update: { enabled: false },
  },
  {
    name: 'InvoicePlanLine',
    adapter: adapterFor('invoicePlanLine'),
    create: async (t) => {
      const item = await seedPoItemRow(t);
      const plan = await prisma.invoicePlan.create({ data: { itemPk: item.pk, enabled: true, planNumber: `PLAN-${t}` } });
      return prisma.invoicePlanLine.create({ data: {
        planPk: plan.pk, lineNumber: 1, description: `Milestone ${t}`,
        settlementDate: soon(), percentage: 50, amount: 500,
      } });
    },
    find: (t) => ({ description: `Milestone ${t}` }),
    update: { amount: 1 },
  },
  {
    name: 'AsnItem',
    adapter: adapterFor('asnItem'),
    create: async (t) => {
      const asn = await seedAsnRow();
      return prisma.asnItem.create({ data: {
        asnPk: asn.pk, line: 10, materialCode: `MAT-${t}`, shippedQuantity: 5,
      } });
    },
    find: (t) => ({ materialCode: `MAT-${t}` }),
    update: { shippedQuantity: 1 },
  },
  {
    name: 'GrnItem',
    adapter: adapterFor('grnItem'),
    create: async (t) => {
      const grn = await seedGrnRow();
      return prisma.grnItem.create({ data: {
        grnPk: grn.pk, line: 10, materialCode: `MAT-${t}`, receivedQuantity: 5, acceptedQuantity: 5,
      } });
    },
    find: (t) => ({ materialCode: `MAT-${t}` }),
    update: { rejectedQuantity: 5 },
  },
  {
    name: 'InvoiceItem',
    adapter: adapterFor('invoiceItem'),
    create: async (t) => {
      const invoice = await seedInvoiceRow();
      return prisma.invoiceItem.create({ data: {
        invoicePk: invoice.pk, line: 10, materialCode: `MAT-${t}`,
        quantity: 5, unitPrice: 20, amount: 100,
      } });
    },
    find: (t) => ({ materialCode: `MAT-${t}` }),
    update: { amount: 1 },
  },
];

beforeEach(async () => {
  await seedClient(A);
  await seedClient({ ...B, companyName: 'Rival Manufacturing' });
});

// The rule this file's header states, enforced instead of asserted. A model
// registered with the tenant extension but absent from MODEL_CASES has no
// cross-tenant regression test, and nothing else in either suite would
// notice it was gone -- which is how eleven of twenty-two models, RfqBid
// and its per-line sealed pricing among them, came to be scoped in
// production but untested here. A failure means: add the case. Do not
// relax this.
it('has a case for every model the tenant extension scopes', () => {
  const covered = new Set(MODEL_CASES.map(({ name }) => name));
  const missing = [...TENANT_SCOPED_MODELS].filter((model) => !covered.has(model));
  expect(missing).toEqual([]);
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
      await prisma.payment.create({
        data: {
          id: 'PMT-000777', vendorId: 'VND-B', netAmount: 11.8, paymentDate: new Date(), utrCode: 'UTRB',
          items: { create: [{ clientId: B.clientId, invoiceId: 'INV-000777', poId: 'PO-2026-0777', netAmount: 11.8 }] },
        },
      });
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
