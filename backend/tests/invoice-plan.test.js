const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createAdminUser } = require('./helpers');
const { prisma } = require('../db/prisma');
const { PO_INCLUDE } = require('../db/poHelpers');
const { runWithTenant } = require('../utils/tenantContext');
const plan = require('../services/invoicePlan.service');

// Invoicing plans on PO line items — the FPLA/FPLT feature.
//
// Two halves worth testing separately: the arithmetic, which is pure and where
// the interesting mistakes live (month-end drift, a rounding remainder that
// leaves a plan a paisa short of its item), and the endpoints, where the
// interesting mistakes are about who may do what and what a supplier is allowed
// to bill.

const app = buildTestApp();

const seedPO = (overrides = {}) =>
  runWithTenant('CLT-0001', () => prisma.purchaseOrder.create({
    data: {
      id: overrides.id || 'PO-PLAN-0001',
      sapPoNumber: overrides.sapPoNumber || '4500090001',
      vendorId: overrides.vendorId,
      buyerName: 'Test Buyer',
      currency: 'INR',
      status: overrides.status || 'Open',
      createdDate: new Date('2026-01-10'),
      items: {
        create: (overrides.items || [
          { line: 10, materialCode: 'MAT-3849', description: 'Annual maintenance', quantity: 1, grnQuantity: 0, unitPrice: 50000, netValue: 50000, uom: 'EA' },
          { line: 20, materialCode: 'MAT-9210', description: 'Flange', quantity: 5, grnQuantity: 0, unitPrice: 200, netValue: 1000, uom: 'EA' },
        ]).map((item) => ({ clientId: 'CLT-0001', ...item })),
      },
    },
  }));

describe('invoicing plan arithmetic', () => {
  it('generates one periodic date per period, anchored to the start date', () => {
    const built = plan.buildPlan(
      { type: 'Periodic', startDate: '2026-01-31', endDate: '2027-01-31', frequency: 'Monthly' },
      { item: { netValue: 50000 } },
    );

    // Twelve, not thirteen. Stepping month-by-month from 31 January clamps to
    // 28 February and never climbs back, growing a spurious stub period at the
    // end; measuring each period from the start date does not.
    expect(built.lines).toHaveLength(12);
    expect(built.lines.every((line) => line.amount === 50000)).toBe(true);
    expect(built.periodicAmount).toBe(50000);
  });

  it('settles a periodic plan at the end of each period in arrears, and at the start in advance', () => {
    const args = { type: 'Periodic', startDate: '2026-01-01', endDate: '2026-04-01', frequency: 'Monthly' };
    const context = { item: { netValue: 1000 } };

    const arrears = plan.buildPlan({ ...args, invoicingRule: 'Arrears' }, context);
    const advance = plan.buildPlan({ ...args, invoicingRule: 'Advance' }, context);

    expect(arrears.lines.map((l) => l.settlementDate.toISOString().slice(0, 10)))
      .toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(advance.lines.map((l) => l.settlementDate.toISOString().slice(0, 10)))
      .toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('splits a partial plan to exactly the line value, remainder on the last instalment', () => {
    const built = plan.buildPlan({
      type: 'Partial',
      milestones: [
        { settlementDate: '2026-03-01', percentage: 33.33 },
        { settlementDate: '2026-04-01', percentage: 33.33 },
        { settlementDate: '2026-05-01', percentage: 33.33 },
      ],
    }, { item: { netValue: 100 } });

    expect(built.lines.map((l) => l.amount)).toEqual([33.33, 33.33, 33.34]);
    expect(plan.round2(built.lines.reduce((sum, l) => sum + l.amount, 0))).toBe(100);
  });

  it('refuses a partial plan whose instalments do not add up to the line', () => {
    expect(() => plan.buildPlan({
      type: 'Partial',
      milestones: [{ settlementDate: '2026-03-01', percentage: 40 }],
    }, { item: { netValue: 1000 } })).toThrow(/must add up to the full line value/);
  });

  it('refuses a schedule long enough to be a typo rather than a plan', () => {
    expect(() => plan.buildPlan(
      { type: 'Periodic', startDate: '2026-01-01', endDate: '2099-01-01', frequency: 'Weekly' },
      { item: { netValue: 100 } },
    )).toThrow(/more than 240 invoicing dates/);
  });

  it('keeps an already-invoiced date when the rest of the schedule is replaced', () => {
    const existing = {
      lines: [{ lineNumber: 10, settlementDate: new Date('2026-01-31'), amount: 5000, percentage: 0, status: 'Invoiced', invoiceId: 'INV-1', invoiceNumber: 'V/1' }],
    };
    const rebuilt = plan.buildPlan(
      { type: 'Periodic', startDate: '2026-01-01', endDate: '2026-04-01', frequency: 'Monthly' },
      { item: { netValue: 9999 }, existingPlan: existing },
    );

    const carried = rebuilt.lines.find((line) => line.lineNumber === 10);
    expect(carried.status).toBe('Invoiced');
    expect(carried.invoiceId).toBe('INV-1');
    // The billed amount is what was billed, not what the new schedule says.
    expect(carried.amount).toBe(5000);
  });

  it('reports only dates whose settlement has arrived as billable', () => {
    const po = {
      id: 'PO-1',
      items: [{
        line: 10,
        invoicePlan: {
          enabled: true,
          type: 'Partial',
          lines: [
            { lineNumber: 10, settlementDate: new Date('2020-01-01'), amount: 100, status: 'Open', blocked: false },
            { lineNumber: 20, settlementDate: new Date('2020-01-01'), amount: 100, status: 'Open', blocked: true },
            { lineNumber: 30, settlementDate: new Date('2099-01-01'), amount: 100, status: 'Open', blocked: false },
            { lineNumber: 40, settlementDate: new Date('2020-01-01'), amount: 100, status: 'Invoiced', blocked: false },
          ],
        },
      }],
    };

    expect(plan.billablePlanLines(po).map((line) => line.planLineNumber)).toEqual([10]);
    expect(plan.summarizePlan(po.items[0].invoicePlan).blockedLines).toBe(1);
  });
});

describe('invoicing plan endpoints', () => {
  const configure = (token, poId, line, body) =>
    request(app).put(`/api/pos/${poId}/items/${line}/invoice-plan`).set('Authorization', `Bearer ${token}`).send(body);

  const partialBody = {
    type: 'Partial',
    milestones: [
      { settlementDate: '2020-01-01', percentage: 40, description: 'On order' },
      { settlementDate: '2099-01-01', percentage: 60, description: 'On commissioning' },
    ],
  };

  it('lets the buying organisation configure a plan and reports it on the order', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_plan_1', gstin: '27AAAAA1001A1Z1' }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: 'plan-admin-1@example.com' });
    await seedPO({ id: 'PO-PLAN-1', vendorId: vendor.vendorId });

    const saved = await configure(adminToken, 'PO-PLAN-1', 10, partialBody);
    expect(saved.status).toBe(200);
    expect(saved.body.item.plan.type).toBe('Partial');
    expect(saved.body.item.plan.lines.map((l) => l.amount)).toEqual([20000, 30000]);
    // The mock driver stands in for the ME22N write and hands back the FPLA number.
    expect(saved.body.item.plan.planNumber).toBeTruthy();

    const read = await request(app).get('/api/pos/PO-PLAN-1/invoice-plan').set('Authorization', `Bearer ${adminToken}`);
    expect(read.body.invoicePlanningEnabled).toBe(true);
    expect(read.body.items).toHaveLength(1);
    // Only the first milestone has come due; the 2099 one has not.
    expect(read.body.billable.map((b) => b.planLineNumber)).toEqual([10]);
  });

  it('does not let a supplier configure a plan on their own order', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_plan_2', gstin: '27AAAAA1002A1Z1' }, { onboarded: true });
    await seedPO({ id: 'PO-PLAN-2', vendorId: vendor.vendorId });

    const res = await configure(token, 'PO-PLAN-2', 10, partialBody);
    expect(res.status).toBe(403);
  });

  it('leaves an order without invoice planning exactly as it was', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_plan_3', gstin: '27AAAAA1003A1Z1' }, { onboarded: true });
    await seedPO({ id: 'PO-PLAN-3', vendorId: vendor.vendorId });

    const res = await request(app).get('/api/pos/PO-PLAN-3/invoice-plan').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.invoicePlanningEnabled).toBe(false);
    expect(res.body.items).toEqual([]);
    expect(res.body.billable).toEqual([]);
  });

  it('blocks and releases one date without touching the schedule', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_plan_4', gstin: '27AAAAA1004A1Z1' }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: 'plan-admin-4@example.com' });
    await seedPO({ id: 'PO-PLAN-4', vendorId: vendor.vendorId });
    await configure(adminToken, 'PO-PLAN-4', 10, partialBody);

    const blocked = await request(app)
      .put('/api/pos/PO-PLAN-4/items/10/invoice-plan/lines/10/block')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ blocked: true });

    expect(blocked.status).toBe(200);
    expect(blocked.body.item.plan.lines).toHaveLength(2);
    expect(blocked.body.item.summary.dueLines).toBe(0);
    expect(blocked.body.item.summary.blockedLines).toBe(1);
  });

  it('refuses to remove a plan that has already been billed against', async () => {
    const { vendor } = await registerVendor(app, { vendorId: 'vendor_plan_5', gstin: '27AAAAA1005A1Z1' }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: 'plan-admin-5@example.com' });
    await seedPO({ id: 'PO-PLAN-5', vendorId: vendor.vendorId });
    await configure(adminToken, 'PO-PLAN-5', 10, partialBody);

    // A plan invoice is no longer raised through the API — MIRO is AP's
    // transaction, not a supplier's (PROJECT_CONTEXT.md §5.6). Seeded
    // directly, the same "already billed" precondition AP posting one in SAP
    // would leave behind.
    const rawPo = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-PLAN-5' }, include: PO_INCLUDE }));
    const rawItem = rawPo.items.find((i) => i.line === 10);
    const planLine = rawItem.invoicePlan.lines.find((l) => l.lineNumber === 10);
    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-PLAN-BILLED-5', poId: rawPo.id, vendorId: vendor.vendorId,
        invoiceNumber: 'V/2026/1', invoiceDate: new Date('2026-02-01'),
        subTotal: 20000, taxAmount: 3600, totalAmount: 23600,
        invoicePlanRef: { line: 10, planLineNumber: 10, planType: 'Partial', settlementDate: planLine.settlementDate },
      },
    }));
    await runWithTenant('CLT-0001', () => prisma.invoicePlanLine.update({
      where: { pk: planLine.pk },
      data: { status: 'Invoiced', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, invoicedAt: new Date() },
    }));

    const removed = await request(app)
      .delete('/api/pos/PO-PLAN-5/items/10/invoice-plan')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(removed.status).toBe(400);
    expect(removed.body.error).toMatch(/already been invoiced/);
  });
});
