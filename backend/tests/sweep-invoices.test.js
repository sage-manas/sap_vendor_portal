// sweepInvoices — invoice creation was removed from the portal (a9fe9ac);
// this sweep is what an Invoice row's existence now depends on entirely,
// the same "SAP originated it" shape as sweepPurchaseOrders/sweepPayments
// (see jobs/handlers/sweepInvoices.js's own header comment).
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const sweepInvoices = require('../jobs/handlers/sweepInvoices');
const { seedClient } = require('./helpers');

const seedVendor = (clientId, vendorId, sapVendorCode) => runWithTenant(clientId, () => prisma.vendor.create({
  data: {
    vendorId, sapVendorCode,
    companyName: `${vendorId} Pvt Ltd`,
    gstin: `27AAAAA${vendorId.slice(-4).padStart(4, '0')}A1Z${vendorId.length % 10}`,
    pan: `AAAAA${vendorId.slice(-4).padStart(4, '0')}A`,
    email: `${vendorId}@example.com`,
  },
}));

// The mock driver's vendorMiroDisplay echoes `poNumber: invoice.poId`
// (mock.driver.js — it has direct access to the invoice's own poId field,
// unlike a real system), so a PO's sapPoNumber has to equal its own portal
// id for sap/mappings/invoice-match.js's PO+amount match — and this
// handler's own PO correlation — to succeed against the mock. Same
// convention tests/invoice-sap-status.test.js uses for the same reason.
const seedPo = (clientId, { id, vendorId }) => runWithTenant(clientId, () => prisma.purchaseOrder.create({
  data: { id, vendorId, sapPoNumber: id, sapDocNumber: id, sapSyncState: 'synced', status: 'Delivered' },
}));

const seedGrn = async (clientId, { id, poId, vendorId, invoiceSubmitted = false, postingDate = new Date() }) => {
  const asn = await runWithTenant(clientId, () => prisma.aSN.create({
    data: { id: `ASN-${id}`, poId, vendorId, status: 'Received', shipDate: postingDate, estimatedDeliveryDate: postingDate },
  }));
  return runWithTenant(clientId, () => prisma.gRN.create({
    data: { id, poId, asnId: asn.id, vendorId, postingDate, invoiceSubmitted },
  }));
};

const discoveryInvoice = (poId, overrides = {}) => ({
  poId,
  currency: 'INR',
  subTotal: 500,
  totalAmount: 590,
  taxCode: 'G1',
  invoiceDate: new Date('2026-06-01'),
  items: [{ line: 10, materialCode: 'MAT-1', amount: 500, quantity: 10 }],
  ...overrides,
});

const runSweep = (clientId, discoveries) => runWithTenant(clientId, () => sweepInvoices({
  job: { clientId, args: {} },
  adapter: buildTransientAdapter({ clientId, driver: 'mock', config: { discoveries }, secrets: {} }),
}));

beforeEach(() => seedClient());

describe('sweepInvoices discovery', () => {
  it('creates an Invoice for a MIRO document SAP already holds, claiming the oldest un-invoiced GRN', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_1', 'VENINV1');
    const po = await seedPo('CLT-0001', { id: 'PO-INVSWEEP-1', vendorId: 'vendor_inv_1' });
    const grn = await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-1', poId: po.id, vendorId: 'vendor_inv_1' });

    await runSweep('CLT-0001', { invoice: [discoveryInvoice(po.id)] });

    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.findFirst({
      where: { poId: po.id }, include: { items: true },
    }));
    expect(invoice).toBeTruthy();
    expect(invoice.grnId).toBe(grn.id);
    expect(invoice.vendorId).toBe('vendor_inv_1');
    expect(invoice.sapSyncState).toBe('synced');
    expect(Number(invoice.totalAmount)).toBe(590);
    expect(Number(invoice.subTotal)).toBe(500);
    expect(Number(invoice.taxAmount)).toBeCloseTo(90, 2);
    expect(invoice.items).toHaveLength(1);
    expect(invoice.items[0].materialCode).toBe('MAT-1');

    const reloadedGrn = await runWithTenant('CLT-0001', () => prisma.gRN.findFirst({ where: { pk: grn.pk } }));
    expect(reloadedGrn.invoiceSubmitted).toBe(true);
  });

  it('claims the oldest un-invoiced GRN when the PO has more than one', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_2', 'VENINV2');
    const po = await seedPo('CLT-0001', { id: 'PO-INVSWEEP-2', vendorId: 'vendor_inv_2' });
    const older = await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-2A', poId: po.id, vendorId: 'vendor_inv_2', postingDate: new Date('2026-01-01') });
    await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-2B', poId: po.id, vendorId: 'vendor_inv_2', postingDate: new Date('2026-02-01') });

    await runSweep('CLT-0001', { invoice: [discoveryInvoice(po.id)] });

    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.findFirst({ where: { poId: po.id } }));
    expect(invoice.grnId).toBe(older.id);
  });

  it('does not create a duplicate when the document is already known by its MIRO number', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_3', 'VENINV3');
    const po = await seedPo('CLT-0001', { id: 'PO-INVSWEEP-3', vendorId: 'vendor_inv_3' });
    await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-3', poId: po.id, vendorId: 'vendor_inv_3' });

    // Fixed sapMiroDoc so the mock echoes exactly this, and an existing
    // local invoice already carries it.
    const doc = discoveryInvoice(po.id, { sapMiroDoc: 'MIRO-KNOWN-1' });
    await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-INVSWEEP-3', poId: po.id, vendorId: 'vendor_inv_3', invoiceNumber: 'SUP-1',
        invoiceDate: new Date(), sapMiroDoc: 'MIRO-KNOWN-1', subTotal: 500, taxAmount: 90, totalAmount: 590,
        invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date().toISOString() },
      },
    }));

    await runSweep('CLT-0001', { invoice: [doc] });

    const count = await runWithTenant('CLT-0001', () => prisma.invoice.count({ where: { poId: po.id } }));
    expect(count).toBe(1);
  });

  it('backfills sapMiroDoc onto an already-existing unmatched invoice instead of creating a duplicate', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_4', 'VENINV4');
    const po = await seedPo('CLT-0001', { id: 'PO-INVSWEEP-4', vendorId: 'vendor_inv_4' });
    const grn = await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-4', poId: po.id, vendorId: 'vendor_inv_4' });

    const invoiceDate = new Date('2026-06-01');
    const existing = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-INVSWEEP-4', grnId: grn.id, poId: po.id, vendorId: 'vendor_inv_4', invoiceNumber: 'SUP-2',
        invoiceDate, subTotal: 500, taxAmount: 90, totalAmount: 590,
      },
    }));

    await runSweep('CLT-0001', { invoice: [discoveryInvoice(po.id, { totalAmount: 590, invoiceDate })] });

    const reloaded = await runWithTenant('CLT-0001', () => prisma.invoice.findFirst({ where: { pk: existing.pk } }));
    expect(reloaded.sapMiroDoc).toBeTruthy();
    expect(reloaded.sapSyncState).toBe('synced');

    const count = await runWithTenant('CLT-0001', () => prisma.invoice.count({ where: { poId: po.id } }));
    expect(count).toBe(1); // backfilled, not duplicated

    // The GRN it already named stays exactly as it was — backfilling a
    // match is not the same event as claiming a fresh receipt.
    const reloadedGrn = await runWithTenant('CLT-0001', () => prisma.gRN.findFirst({ where: { pk: grn.pk } }));
    expect(reloadedGrn.invoiceSubmitted).toBe(false);
  });

  it('skips a document when the PO has no un-invoiced GRN to claim', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_5', 'VENINV5');
    const po = await seedPo('CLT-0001', { id: 'PO-INVSWEEP-5', vendorId: 'vendor_inv_5' });
    await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-5', poId: po.id, vendorId: 'vendor_inv_5', invoiceSubmitted: true });

    await runSweep('CLT-0001', { invoice: [discoveryInvoice(po.id)] });

    const count = await runWithTenant('CLT-0001', () => prisma.invoice.count({ where: { poId: po.id } }));
    expect(count).toBe(0);
  });

  it('skips a document whose PO the portal has no record of', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_6', 'VENINV6');

    await runSweep('CLT-0001', { invoice: [discoveryInvoice('PO-NEVER-AWARDED')] });

    const count = await runWithTenant('CLT-0001', () => prisma.invoice.count({ where: { vendorId: 'vendor_inv_6' } }));
    expect(count).toBe(0);
  });

  // Issue #72's own suggested pattern (a conditional updateMany, count === 0
  // means lost the race) — applied here to the discovery path rather than
  // the removed submitInvoice endpoint. Two ticks racing for the same
  // receipt must not both win.
  it('two concurrent sweep ticks against the same receipt produce exactly one invoice', async () => {
    await seedVendor('CLT-0001', 'vendor_inv_7', 'VENINV7');
    const po = await seedPo('CLT-0001', { id: 'PO-INVSWEEP-7', vendorId: 'vendor_inv_7' });
    await seedGrn('CLT-0001', { id: 'GRN-INVSWEEP-7', poId: po.id, vendorId: 'vendor_inv_7' });

    await Promise.all([
      runSweep('CLT-0001', { invoice: [discoveryInvoice(po.id)] }),
      runSweep('CLT-0001', { invoice: [discoveryInvoice(po.id)] }),
    ]);

    const count = await runWithTenant('CLT-0001', () => prisma.invoice.count({ where: { poId: po.id } }));
    expect(count).toBe(1);
  });
});
