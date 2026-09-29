// Issue #73: sweepPurchaseOrders used to return immediately for any order
// already `synced` — a discovery-only sweep that then never looked at that
// order again, however much SAP's own copy moved on. This suite exercises
// the fix directly: a field-level reconcile that keeps writing to an
// already-correlated order, and marks (never silently drops) one that has
// disappeared from SAP's ledger entirely.
jest.mock('../jobs/notify');

const { prisma, rawPrisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { buildTransientAdapter } = require('../sap');
const { EVENTS } = require('../utils/socketEmitter');
const sweepPurchaseOrders = require('../jobs/handlers/sweepPurchaseOrders');
const { notifyVendor } = require('../jobs/notify');

const seedVendor = (clientId, vendorId, sapVendorCode) => runWithTenant(clientId, () => prisma.vendor.create({
  data: {
    vendorId, sapVendorCode,
    companyName: `${vendorId} Pvt Ltd`,
    gstin: `27AAAAA${vendorId.slice(-4).padStart(4, '0')}A1Z1`,
    pan: `AAAAA${vendorId.slice(-4).padStart(4, '0')}A`,
    email: `${vendorId}@example.com`,
  },
}));

const seedSyncedPo = (clientId, id, vendorId, sapPoNumber, items) => runWithTenant(clientId, () => prisma.purchaseOrder.create({
  data: {
    // companyCode matches the mock driver's own behaviour default (see
    // mock.driver.js's `po.companyCode || behaviour.companyCode`) so a
    // header diff shows up only when a test deliberately introduces one,
    // not as noise from the mock filling in what this row never set.
    id, vendorId, status: 'Open', buyerName: 'SAP System Procurement', currency: 'INR', companyCode: '1000',
    sapPoNumber, sapDocNumber: sapPoNumber, sapSyncState: 'synced', sapSyncedAt: new Date(0),
    items: { create: items.map((item) => ({ clientId, ...item })) },
  },
  include: { items: true },
}));

const discoveryPo = (sapPoNumber, overrides = {}) => ({
  sapPoNumber,
  buyerName: 'SAP System Procurement',
  currency: 'INR',
  items: [],
  ...overrides,
});

// Force the vendor due again without waiting out adaptivePolling's real
// interval — same trick discovery-sweeps.test.js uses for its own
// idempotency case.
const forceDue = (clientId, vendorCode) => withoutTenantScope(() => rawPrisma.sapSyncCursor.updateMany({
  where: { clientId, feed: 'po', vendorCode },
  data: { lastRunAt: new Date(Date.now() - 24 * 3600 * 1000) },
}));

const runSweep = (clientId, discoveries, extraConfig = {}) => runWithTenant(clientId, () => sweepPurchaseOrders({
  job: { clientId, args: {} },
  adapter: buildTransientAdapter({ clientId, driver: 'mock', config: { discoveries, ...extraConfig }, secrets: {} }),
}));

beforeEach(() => notifyVendor.mockClear());

describe('sweepPurchaseOrders reconciles an already-correlated order (issue #73)', () => {
  it('a line quantity/price change in SAP lands after the next sweep, and again after a second one', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_1', 'VENRC1');
    await seedSyncedPo('CLT-0001', 'PO-RECON-1', 'vendor_recon_1', '4500099101', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);

    await runSweep('CLT-0001', {
      po: [discoveryPo('4500099101', {
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 15, grnQuantity: 0, unitPrice: 75, netValue: 1125, uom: 'EA' }],
      })],
    });

    let po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-1' }, include: { items: true } }));
    expect(Number(po.items[0].quantity)).toBe(15);
    expect(Number(po.items[0].unitPrice)).toBe(75);
    expect(Number(po.items[0].netValue)).toBe(1125);
    expect(po.sapSyncState).toBe('synced'); // still correlation, not freshness
    expect(po.sapSyncedAt.getTime()).toBeGreaterThan(0);

    // Sweep again with a second SAP-side change — nothing about the first
    // fix's early-return survives once, this proves it keeps working.
    await forceDue('CLT-0001', 'VENRC1');
    await runSweep('CLT-0001', {
      po: [discoveryPo('4500099101', {
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 20, grnQuantity: 0, unitPrice: 75, netValue: 1500, uom: 'EA' }],
      })],
    });

    po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-1' }, include: { items: true } }));
    expect(Number(po.items[0].quantity)).toBe(20);
  });

  it('a received-quantity refresh moves PO status forward, never backward', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_2', 'VENRC2');
    await seedSyncedPo('CLT-0001', 'PO-RECON-2', 'vendor_recon_2', '4500099102', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);

    await runSweep('CLT-0001', {
      po: [discoveryPo('4500099102', {
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 10, unitPrice: 50, netValue: 500, uom: 'EA' }],
      })],
    });

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-2' }, include: { items: true } }));
    expect(Number(po.items[0].grnQuantity)).toBe(10);
    expect(po.status).toBe('Delivered');
  });

  it('a header field change (buyer reassigned) is written without touching untouched lines', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_3', 'VENRC3');
    await seedSyncedPo('CLT-0001', 'PO-RECON-3', 'vendor_recon_3', '4500099103', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);

    await runSweep('CLT-0001', {
      po: [discoveryPo('4500099103', {
        buyerName: 'New Buyer',
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' }],
      })],
    });

    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-3' }, include: { items: true } }));
    expect(po.buyerName).toBe('New Buyer');
    expect(Number(po.items[0].quantity)).toBe(10); // unchanged line, untouched
  });

  it('notifies the vendor for a line not yet shipped, using po:updated', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_4', 'VENRC4');
    await seedSyncedPo('CLT-0001', 'PO-RECON-4', 'vendor_recon_4', '4500099104', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);

    await runSweep('CLT-0001', {
      po: [discoveryPo('4500099104', {
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 15, grnQuantity: 0, unitPrice: 50, netValue: 750, uom: 'EA' }],
      })],
    });

    expect(notifyVendor).toHaveBeenCalledWith(
      'CLT-0001', 'vendor_recon_4', EVENTS.PO_UPDATED,
      expect.objectContaining({ id: 'PO-RECON-4', lines: [expect.objectContaining({ line: 10, quantity: 15 })] }),
    );
  });

  it('does not notify the vendor about a line already shipped', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_5', 'VENRC5');
    const po = await seedSyncedPo('CLT-0001', 'PO-RECON-5', 'vendor_recon_5', '4500099105', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);
    await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: {
        id: 'ASN-RECON-5', poId: po.id, vendorId: 'vendor_recon_5',
        shipDate: new Date(), estimatedDeliveryDate: new Date(),
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', shippedQuantity: 10, uom: 'EA' }] },
      },
    }));

    await runSweep('CLT-0001', {
      po: [discoveryPo('4500099105', {
        items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 15, grnQuantity: 0, unitPrice: 50, netValue: 750, uom: 'EA' }],
      })],
    });

    // The write still happens — SAP stays the system of record — only the
    // interruption to the supplier is suppressed for a line already shipped.
    const reloaded = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-5' }, include: { items: true } }));
    expect(Number(reloaded.items[0].quantity)).toBe(15);
    expect(notifyVendor).not.toHaveBeenCalledWith('CLT-0001', 'vendor_recon_5', EVENTS.PO_UPDATED, expect.anything());
  });

  it('marks an order absent from SAP\'s ledger as deleted, without discarding it', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_6', 'VENRC6');
    const po = await seedSyncedPo('CLT-0001', 'PO-RECON-6', 'vendor_recon_6', '4500099106', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);

    // vanishedPoIds is this suite's own knob on the mock driver (issue #73):
    // the driver otherwise always echoes back every local PO it's handed, so
    // this is the one way to say "SAP no longer lists this one" for a row
    // the portal already has.
    await runSweep('CLT-0001', { po: [] }, { vanishedPoIds: [po.id] });

    const reloaded = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { pk: po.pk } }));
    expect(reloaded).toBeTruthy(); // still there — marked, not dropped
    expect(reloaded.sapDeletedAt).toBeTruthy();
    expect(reloaded.status).toBe('Open'); // untouched — no PoStatus value means "gone"

    expect(notifyVendor).toHaveBeenCalledWith(
      'CLT-0001', 'vendor_recon_6', EVENTS.PO_DELETED,
      expect.objectContaining({ id: 'PO-RECON-6', sapPoNumber: '4500099106' }),
    );
  });

  it('never marks a portal-only order that has not yet been correlated', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_7', 'VENRC7');
    const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
      data: {
        id: 'PO-RECON-7', vendorId: 'vendor_recon_7', status: 'Open', sapSyncState: 'pending',
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' }] },
      },
    }));

    await runSweep('CLT-0001', {}, { vanishedPoIds: [po.id] });

    const reloaded = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { pk: po.pk } }));
    expect(reloaded.sapDeletedAt).toBeNull();
  });

  it('a repeated sweep over an unchanged order (same fingerprint) writes nothing new and does not re-notify', async () => {
    await seedVendor('CLT-0001', 'vendor_recon_8', 'VENRC8');
    await seedSyncedPo('CLT-0001', 'PO-RECON-8', 'vendor_recon_8', '4500099108', [
      { line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
    ]);
    const order = discoveryPo('4500099108', {
      items: [{ line: 10, materialCode: 'MAT-1', description: 'Widget', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' }],
    });

    await runSweep('CLT-0001', { po: [order] });
    const afterFirst = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-8' } }));

    // An identical SAP answer keeps the same fingerprint (jobs/fingerprint.js
    // / recordSweepTick), so the reconcile never even runs a second time —
    // the cost saving the whole sweep design depends on (Phase 4.2). Nothing
    // about this order moves, sapSyncedAt included.
    await forceDue('CLT-0001', 'VENRC8');
    notifyVendor.mockClear();
    await runSweep('CLT-0001', { po: [order] });
    const afterSecond = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-RECON-8' } }));

    expect(afterSecond.sapSyncedAt.getTime()).toBe(afterFirst.sapSyncedAt.getTime());
    expect(notifyVendor).not.toHaveBeenCalled();
  });
});
