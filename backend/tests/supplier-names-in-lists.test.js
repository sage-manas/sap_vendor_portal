const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');

// Finding 4.3. The workspace PO and invoice lists are the tenant-wide,
// every-supplier views — and both printed `vendorId` in a column headed
// "Supplier". `vendorId` is the portal's own internal key ('vendor_test_001',
// or a seeded 'VEND-00042'), not the SAP vendor code and not anything a buyer
// recognises: staff were reading a list of orders identified by a string they
// have no way to resolve to a company without opening each row.
//
// The name has to come from the API rather than being joined in the browser.
// The supplier list is a separate, paginated endpoint, so the client cannot
// build that map without fetching every supplier in the tenant first — which
// is both a second round trip and wrong the moment a tenant has more suppliers
// than one page.
//
// Seeding note (AGENTS.md): the PO/invoice rows below are preconditions, not
// the thing under test. The endpoint under test is the GET list; a purchase
// order is produced by awarding an RFQ, which this suite is not exercising,
// and tests/tenant-wide-visibility.test.js seeds the same historical trade
// rows the same way for the same reason.

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

const seedTradeFor = (vendorId, suffix) => asTenant(async () => {
  await prisma.purchaseOrder.create({ data: { id: `PO-2026-${suffix}`, vendorId } });
  await prisma.invoice.create({
    data: {
      id: `INV-${suffix}`, poId: `PO-2026-${suffix}`, vendorId,
      invoiceNumber: `INV/${suffix}`, invoiceDate: new Date(),
      subTotal: 100, taxAmount: 18, totalAmount: 118,
      // grnId and invoicePlanRef are mutually exclusive (a CHECK constraint,
      // not expressible in the Prisma schema) — the plan-raised shape avoids
      // seeding a PO -> ASN -> GRN chain this suite has no use for.
      invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
    },
  });
});

const ACME = { vendorId: 'vendor_name_a', companyName: 'Acme Industries Pvt Ltd', gstin: '27AAAAA2221A1Z1' };
const BETA = { vendorId: 'vendor_name_b', companyName: 'Beta Supplies Pvt Ltd', gstin: '27AAAAA2222A1Z1', email: 'beta-names@example.com' };

const seedTwoSuppliers = async () => {
  const a = await registerVendor(app, ACME, { onboarded: true });
  const b = await registerVendor(app, BETA, { onboarded: true });
  await seedTradeFor(ACME.vendorId, 'NA');
  await seedTradeFor(BETA.vendorId, 'NB');
  return { a, b };
};

describe.each([
  ['client_admin', ROLES.CLIENT_ADMIN],
  ['buyer', ROLES.BUYER],
  ['finance', ROLES.FINANCE],
])('tenant staff see who a document belongs to, not just its vendor code (%s)', (label, role) => {
  it('GET /api/pos names the supplying company on every row', async () => {
    await seedTwoSuppliers();
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/pos').set(auth(token)).query({ limit: 100 });

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.pos.map((po) => [po.id, po]));
    expect(byId['PO-2026-NA'].vendorName).toBe(ACME.companyName);
    expect(byId['PO-2026-NB'].vendorName).toBe(BETA.companyName);

    // The code is still there — it is what SAP and the detail route key on,
    // so this adds a field rather than replacing one.
    expect(byId['PO-2026-NA'].vendorId).toBe(ACME.vendorId);
  });

  it('GET /api/invoices names the supplying company on every row', async () => {
    await seedTwoSuppliers();
    const { token } = await createTenantUser({ role });

    const res = await request(app).get('/api/invoices').set(auth(token)).query({ limit: 100 });

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.invoices.map((invoice) => [invoice.id, invoice]));
    expect(byId['INV-NA'].vendorName).toBe(ACME.companyName);
    expect(byId['INV-NB'].vendorName).toBe(BETA.companyName);
    expect(byId['INV-NA'].vendorId).toBe(ACME.vendorId);
  });
});

describe('two suppliers in one list are each named', () => {
  it('GET /api/pos resolves every distinct supplier on the page', async () => {
    const vendors = [];
    for (let index = 0; index < 4; index += 1) {
      const vendorId = `vendor_fanout_${index}`;
      const companyName = `Fanout Supplier ${index} Pvt Ltd`;
      await registerVendor(app, {
        vendorId,
        companyName,
        gstin: `27AAAAA33${index}1A1Z1`,
        pan: `AAAAA33${index}1A`,
        email: `fanout${index}@example.com`,
      }, { onboarded: true });
      await seedTradeFor(vendorId, `F${index}`);
      vendors.push({ vendorId, companyName });
    }

    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });
    const res = await request(app).get('/api/pos').set(auth(token)).query({ limit: 100 });

    expect(res.status).toBe(200);
    for (const { vendorId, companyName } of vendors) {
      expect(res.body.pos.find((po) => po.vendorId === vendorId).vendorName).toBe(companyName);
    }
  });
});

describe('an order whose supplier this tenant does not hold is named null, not blank', () => {
  it('a LIFNR the portal never onboarded comes back with vendorName: null', async () => {
    // What jobs/handlers/sweepPurchaseOrders.js writes for an order SAP's own
    // ledger reports against a vendor code this tenant has no Vendor row for.
    // The honest answer is "we hold no company for this code" — the list then
    // renders the code rather than an empty cell.
    await asTenant(() => prisma.purchaseOrder.create({
      data: { id: 'PO-2026-ORPHAN', vendorId: 'LIFNR-77001' },
    }));
    const { token } = await createTenantUser({ role: ROLES.CLIENT_ADMIN });

    const res = await request(app).get('/api/pos').set(auth(token)).query({ limit: 100 });

    expect(res.status).toBe(200);
    expect(res.body.pos.find((po) => po.id === 'PO-2026-ORPHAN').vendorName).toBeNull();
  });
});

describe('a supplier is told their own name, and never another supplier\'s', () => {
  it('GET /api/pos for a supplier carries their own company name', async () => {
    const { a } = await seedTwoSuppliers();

    const res = await request(app).get('/api/pos').set(auth(a.token));

    expect(res.status).toBe(200);
    expect(res.body.pos).toHaveLength(1);
    expect(res.body.pos[0].vendorId).toBe(ACME.vendorId);
    expect(res.body.pos[0].vendorName).toBe(ACME.companyName);
  });
});
