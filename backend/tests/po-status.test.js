// PurchaseOrder.status is derived from line-item and document facts, not
// written directly by any controller or job (issue #60). Two halves worth
// testing separately, the same split invoice-plan.test.js uses: the pure
// derivation logic, and the DB-backed helper (syncPoStatus) that applies it.
const { prisma } = require('../db/prisma');
const { runWithTenant } = require('../utils/tenantContext');
const { PO_INCLUDE, syncPoStatus } = require('../db/poHelpers');
const { derivePoStatus, statusRank, STATUS_ORDER } = require('../services/poStatus.service');

describe('derivePoStatus (pure)', () => {
  const noFacts = { asnCount: 0, invoicedQtyByLine: new Map(), invoiceCount: 0, allInvoicesCleared: false };

  it('is Open for a fresh order and Acknowledged once acknowledgedAt is set', () => {
    const items = [{ line: 10, quantity: 10, grnQuantity: 0 }];
    expect(derivePoStatus({ items, acknowledgedAt: null }, noFacts)).toBe('Open');
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, noFacts)).toBe('Acknowledged');
  });

  it('is Dispatched once a shipment exists, even before anything is received', () => {
    const items = [{ line: 10, quantity: 10, grnQuantity: 0 }];
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, { ...noFacts, asnCount: 1 })).toBe('Dispatched');
  });

  it('a receipt on one line of a multi-line order is Dispatched, not Delivered', () => {
    const items = [
      { line: 10, quantity: 10, grnQuantity: 10 },
      { line: 20, quantity: 5, grnQuantity: 0 },
      { line: 30, quantity: 5, grnQuantity: 0 },
    ];
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, { ...noFacts, asnCount: 1 })).toBe('Dispatched');
  });

  it('is Delivered only once every line is fully received', () => {
    const items = [
      { line: 10, quantity: 10, grnQuantity: 10 },
      { line: 20, quantity: 5, grnQuantity: 5 },
    ];
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, { ...noFacts, asnCount: 1 })).toBe('Delivered');
  });

  it('an invoice on one line of a multi-line delivered order is Delivered, not Invoiced', () => {
    const items = [
      { line: 10, quantity: 10, grnQuantity: 10 },
      { line: 20, quantity: 5, grnQuantity: 5 },
    ];
    const facts = { ...noFacts, asnCount: 1, invoicedQtyByLine: new Map([[10, 10]]), invoiceCount: 1 };
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, facts)).toBe('Delivered');
  });

  it('is Invoiced once every line is fully invoiced, and Paid once every invoice has cleared', () => {
    const items = [{ line: 10, quantity: 10, grnQuantity: 10 }];
    const invoiced = { ...noFacts, asnCount: 1, invoicedQtyByLine: new Map([[10, 10]]), invoiceCount: 1, allInvoicesCleared: false };
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, invoiced)).toBe('Invoiced');

    const paid = { ...invoiced, allInvoicesCleared: true };
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, paid)).toBe('Paid');
  });

  it('a plan-enabled line is invoiced only once its plan is complete, not by quantity', () => {
    const openPlan = {
      invoicePlan: {
        enabled: true,
        lines: [
          { status: 'Invoiced', amount: 5000 },
          { status: 'Open', amount: 5000 },
        ],
      },
    };
    const items = [{ line: 10, quantity: 12, grnQuantity: 12, ...openPlan }];
    const facts = { ...noFacts, asnCount: 1, invoiceCount: 1 };

    // One of twelve monthly instalments invoiced: still not Invoiced.
    expect(derivePoStatus({ items, acknowledgedAt: new Date() }, facts)).toBe('Delivered');

    const completePlan = {
      invoicePlan: {
        enabled: true,
        lines: [
          { status: 'Invoiced', amount: 5000 },
          { status: 'Invoiced', amount: 5000 },
        ],
      },
    };
    const doneItems = [{ line: 10, quantity: 12, grnQuantity: 12, ...completePlan }];
    expect(derivePoStatus({ items: doneItems, acknowledgedAt: new Date() }, facts)).toBe('Invoiced');
  });

  it('ranks statuses in lifecycle order, for the caller enforcing monotonic writes', () => {
    expect(STATUS_ORDER).toEqual(['Open', 'Acknowledged', 'Dispatched', 'Delivered', 'Invoiced', 'Paid']);
    expect(statusRank('Open')).toBeLessThan(statusRank('Paid'));
    expect(statusRank('Delivered')).toBeLessThan(statusRank('Invoiced'));
  });
});

describe('syncPoStatus (DB-backed)', () => {
  const seedPo = (overrides = {}) => runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: overrides.id || 'PO-STATUS-0001',
      vendorId: overrides.vendorId || 'vendor_status_1',
      status: overrides.status || 'Open',
      acknowledgedAt: overrides.acknowledgedAt,
      items: {
        create: (overrides.items || [
          { line: 10, materialCode: 'MAT-1', quantity: 10, grnQuantity: 0, unitPrice: 50, netValue: 500, uom: 'EA' },
          { line: 20, materialCode: 'MAT-2', quantity: 5, grnQuantity: 0, unitPrice: 20, netValue: 100, uom: 'EA' },
          { line: 30, materialCode: 'MAT-3', quantity: 5, grnQuantity: 0, unitPrice: 20, netValue: 100, uom: 'EA' },
        ]).map((item) => ({ clientId: 'CLT-0001', ...item })),
      },
    },
    include: PO_INCLUDE,
  }));

  it('a PO acknowledged, shipped and received on one of three lines renders as partially delivered, not Delivered', async () => {
    const po = await seedPo({
      id: 'PO-STATUS-0002', acknowledgedAt: new Date(),
      items: [
        { line: 10, materialCode: 'MAT-1', quantity: 10, grnQuantity: 10, unitPrice: 50, netValue: 500, uom: 'EA' },
        { line: 20, materialCode: 'MAT-2', quantity: 5, grnQuantity: 0, unitPrice: 20, netValue: 100, uom: 'EA' },
        { line: 30, materialCode: 'MAT-3', quantity: 5, grnQuantity: 0, unitPrice: 20, netValue: 100, uom: 'EA' },
      ],
    });
    await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: { id: 'ASN-STATUS-0002', poId: po.id, vendorId: po.vendorId, shipDate: new Date(), estimatedDeliveryDate: new Date() },
    }));

    const result = await runWithTenant('CLT-0001', () => syncPoStatus(prisma, po.pk));
    expect(result.status).toBe('Dispatched');
  });

  it('an invoice against only the delivered line does not flip the whole order to Invoiced', async () => {
    const po = await seedPo({
      id: 'PO-STATUS-0003', acknowledgedAt: new Date(),
      items: [
        { line: 10, materialCode: 'MAT-1', quantity: 10, grnQuantity: 10, unitPrice: 50, netValue: 500, uom: 'EA' },
        { line: 20, materialCode: 'MAT-2', quantity: 5, grnQuantity: 0, unitPrice: 20, netValue: 100, uom: 'EA' },
        { line: 30, materialCode: 'MAT-3', quantity: 5, grnQuantity: 0, unitPrice: 20, netValue: 100, uom: 'EA' },
      ],
    });
    const asn = await runWithTenant('CLT-0001', () => prisma.aSN.create({
      data: { id: 'ASN-STATUS-0003', poId: po.id, vendorId: po.vendorId, shipDate: new Date(), estimatedDeliveryDate: new Date() },
    }));
    const grn = await runWithTenant('CLT-0001', () => prisma.gRN.create({
      data: { id: 'GRN-STATUS-0003', poId: po.id, asnId: asn.id, vendorId: po.vendorId, postingDate: new Date() },
    }));
    await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-STATUS-0003', grnId: grn.id, poId: po.id, vendorId: po.vendorId, invoiceNumber: 'INV-STATUS-0003',
        invoiceDate: new Date(), status: 'Submitted', subTotal: 500, taxAmount: 90, totalAmount: 590,
        items: { create: [{ clientId: 'CLT-0001', line: 10, materialCode: 'MAT-1', quantity: 10, unitPrice: 50, amount: 500 }] },
      },
    }));

    const result = await runWithTenant('CLT-0001', () => syncPoStatus(prisma, po.pk));
    expect(result.status).not.toBe('Invoiced');
    expect(result.status).toBe('Dispatched'); // lines 20/30 are still untouched
  });

  it('a periodic plan does not reach Invoiced until every instalment is billed', async () => {
    const po = await seedPo({
      id: 'PO-STATUS-0004', acknowledgedAt: new Date(),
      items: [{ line: 10, materialCode: 'MAT-1', quantity: 12, grnQuantity: 12, unitPrice: 5000, netValue: 60000, uom: 'EA' }],
    });
    const item = po.items[0];
    const plan = await runWithTenant('CLT-0001', () => prisma.invoicePlan.create({
      data: { itemPk: item.pk, enabled: true, type: 'Periodic', frequency: 'Monthly' },
    }));
    await runWithTenant('CLT-0001', () => prisma.invoicePlanLine.createMany({
      data: Array.from({ length: 12 }, (_, i) => ({
        planPk: plan.pk,
        lineNumber: (i + 1) * 10,
        settlementDate: new Date(2026, i, 28),
        amount: 5000,
        status: i === 0 ? 'Invoiced' : 'Open',
      })),
    }));

    const afterFirstMonth = await runWithTenant('CLT-0001', () => syncPoStatus(prisma, po.pk));
    expect(afterFirstMonth.status).not.toBe('Invoiced');

    await runWithTenant('CLT-0001', () => prisma.invoicePlanLine.updateMany({ where: { planPk: plan.pk }, data: { status: 'Invoiced' } }));

    const afterPlanComplete = await runWithTenant('CLT-0001', () => syncPoStatus(prisma, po.pk));
    expect(afterPlanComplete.status).toBe('Invoiced');
  });

  it('never regresses status, even when the underlying facts would derive an earlier one', async () => {
    const po = await seedPo({ id: 'PO-STATUS-0005', status: 'Paid', acknowledgedAt: new Date() });

    const result = await runWithTenant('CLT-0001', () => syncPoStatus(prisma, po.pk));
    expect(result.status).toBe('Paid');
  });
});
