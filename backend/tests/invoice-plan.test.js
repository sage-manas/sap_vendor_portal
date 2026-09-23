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

describe('a supplier proposing a change to their own invoicing plan', () => {
  const configure = (token, poId, line, body) =>
    request(app).put(`/api/pos/${poId}/items/${line}/invoice-plan`).set('Authorization', `Bearer ${token}`).send(body);
  const propose = (token, poId, line, body) =>
    request(app).put(`/api/pos/${poId}/items/${line}/invoice-plan/propose`).set('Authorization', `Bearer ${token}`).send(body);
  const approve = (token, poId, line) =>
    request(app).put(`/api/pos/${poId}/items/${line}/invoice-plan/propose/approve`).set('Authorization', `Bearer ${token}`).send();
  const reject = (token, poId, line, reason) =>
    request(app).put(`/api/pos/${poId}/items/${line}/invoice-plan/propose/reject`).set('Authorization', `Bearer ${token}`).send({ reason });

  const partialBody = {
    type: 'Partial',
    milestones: [
      { settlementDate: '2020-01-01', percentage: 40, description: 'On order' },
      { settlementDate: '2099-01-01', percentage: 60, description: 'On commissioning' },
    ],
  };

  const setUp = async (n) => {
    const { token, vendor } = await registerVendor(app, { vendorId: `vendor_propose_${n}`, gstin: `27AAAAA20${n}0A1Z1` }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: `plan-propose-admin-${n}@example.com` });
    await seedPO({ id: `PO-PROPOSE-${n}`, vendorId: vendor.vendorId });
    await configure(adminToken, `PO-PROPOSE-${n}`, 10, partialBody);
    return { token, adminToken, vendor };
  };

  it('lets a supplier propose a change without it reaching SAP, then a buyer approve it', async () => {
    const { token, adminToken } = await setUp(1);

    const revised = {
      type: 'Partial',
      milestones: [
        { settlementDate: '2020-06-01', percentage: 50, description: 'On order' },
        { settlementDate: '2099-06-01', percentage: 50, description: 'On commissioning' },
      ],
    };

    const proposed = await propose(token, 'PO-PROPOSE-1', 10, revised);
    expect(proposed.status).toBe(200);
    expect(proposed.body.item.plan.pendingChange).toBeTruthy();
    expect(proposed.body.item.plan.pendingChange.requestedBy).toBe('vendor_propose_1');
    // Not applied: the live schedule is unchanged, still the buyer's original.
    expect(proposed.body.item.plan.lines.map((l) => l.percentage)).toEqual([40, 60]);

    const approved = await approve(adminToken, 'PO-PROPOSE-1', 10);
    expect(approved.status).toBe(200);
    expect(approved.body.item.plan.lines.map((l) => l.percentage)).toEqual([50, 50]);
    expect(approved.body.item.plan.pendingChange).toBeNull();
  });

  it('leaves the live plan untouched when a buyer rejects the proposal', async () => {
    const { token, adminToken } = await setUp(2);
    await propose(token, 'PO-PROPOSE-2', 10, {
      type: 'Partial',
      milestones: [{ settlementDate: '2020-01-01', percentage: 100, description: 'Everything up front' }],
    });

    const rejected = await reject(adminToken, 'PO-PROPOSE-2', 10, 'Not agreed — keep the milestone schedule');
    expect(rejected.status).toBe(200);
    expect(rejected.body.item.plan.pendingChange).toBeNull();
    expect(rejected.body.item.plan.lines.map((l) => l.percentage)).toEqual([40, 60]);

    // Nothing left pending to approve after rejection.
    const reapprove = await approve(adminToken, 'PO-PROPOSE-2', 10);
    expect(reapprove.status).toBe(400);
  });

  it('rejects a rejection with no reason', async () => {
    const { token, adminToken } = await setUp(3);
    await propose(token, 'PO-PROPOSE-3', 10, partialBody);

    const res = await request(app)
      .put('/api/pos/PO-PROPOSE-3/items/10/invoice-plan/propose/reject')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('refuses a proposal that does not reconcile to the line value', async () => {
    const { token } = await setUp(4);
    const res = await propose(token, 'PO-PROPOSE-4', 10, {
      type: 'Partial',
      milestones: [{ settlementDate: '2020-01-01', percentage: 40 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must add up to the full line value/);
  });

  it('refuses a proposal on a line with no invoicing plan to change', async () => {
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_propose_5', gstin: '27AAAAA2050A1Z1' }, { onboarded: true });
    await seedPO({ id: 'PO-PROPOSE-5', vendorId: vendor.vendorId });

    const res = await propose(token, 'PO-PROPOSE-5', 10, partialBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no invoicing plan/);
  });

  it("does not let a supplier propose a change on another supplier's order", async () => {
    const { vendor: owner } = await registerVendor(app, { vendorId: 'vendor_propose_owner_6', gstin: '27AAAAA2061A1Z1', email: 'owner-6@example.com' }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: 'plan-propose-admin-6@example.com' });
    await seedPO({ id: 'PO-PROPOSE-6', vendorId: owner.vendorId });
    await configure(adminToken, 'PO-PROPOSE-6', 10, partialBody);

    const { token: strangerToken } = await registerVendor(app, { vendorId: 'vendor_propose_stranger_6', gstin: '27AAAAA2062A1Z1', email: 'stranger-6@example.com' }, { onboarded: true });

    const res = await propose(strangerToken, 'PO-PROPOSE-6', 10, partialBody);
    expect(res.status).toBe(404);
  });

  it('does not let a supplier approve or reject their own proposal', async () => {
    const { token } = await setUp(7);
    await propose(token, 'PO-PROPOSE-7', 10, partialBody);

    expect((await approve(token, 'PO-PROPOSE-7', 10)).status).toBe(403);
    expect((await reject(token, 'PO-PROPOSE-7', 10, 'no')).status).toBe(403);
  });

  it("a buyer's own edit discards a supplier's pending proposal rather than leaving it stranded", async () => {
    const { token, adminToken } = await setUp(8);
    await propose(token, 'PO-PROPOSE-8', 10, {
      type: 'Partial',
      milestones: [{ settlementDate: '2020-01-01', percentage: 100, description: 'Supplier’s proposal' }],
    });

    const reconfigured = await configure(adminToken, 'PO-PROPOSE-8', 10, {
      type: 'Partial',
      milestones: [{ settlementDate: '2021-01-01', percentage: 100, description: 'Buyer decided differently' }],
    });
    expect(reconfigured.status).toBe(200);
    expect(reconfigured.body.item.plan.pendingChange).toBeNull();
  });

  it('reconciles a proposal against invoicing that happened after it was proposed, not a stale snapshot', async () => {
    const { token, adminToken } = await setUp(9);
    await propose(token, 'PO-PROPOSE-9', 10, {
      type: 'Partial',
      milestones: [
        { settlementDate: '2020-06-01', percentage: 50, description: 'On order' },
        { settlementDate: '2099-06-01', percentage: 50, description: 'On commissioning' },
      ],
    });

    // The first milestone of the ORIGINAL plan gets billed between proposal
    // and approval — exactly the race applyInvoicePlan's rebuild exists for.
    const rawPo = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id: 'PO-PROPOSE-9' }, include: PO_INCLUDE }));
    const rawItem = rawPo.items.find((i) => i.line === 10);
    const planLine = rawItem.invoicePlan.lines.find((l) => l.lineNumber === 10);
    const invoice = await runWithTenant('CLT-0001', () => prisma.invoice.create({
      data: {
        id: 'INV-PLAN-RACE-9', poId: rawPo.id, vendorId: rawPo.vendorId,
        invoiceNumber: 'V/2026/9', invoiceDate: new Date('2026-02-01'),
        subTotal: 20000, taxAmount: 3600, totalAmount: 23600,
        invoicePlanRef: { line: 10, planLineNumber: 10, planType: 'Partial', settlementDate: planLine.settlementDate },
      },
    }));
    await runWithTenant('CLT-0001', () => prisma.invoicePlanLine.update({
      where: { pk: planLine.pk },
      data: { status: 'Invoiced', invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, invoicedAt: new Date() },
    }));

    const approved = await approve(adminToken, 'PO-PROPOSE-9', 10);
    expect(approved.status).toBe(200);
    // buildPlan's own carry-forward rule: a billed date keeps its amount and
    // invoice reference regardless of what the proposal said about it.
    const billedLine = approved.body.item.plan.lines.find((l) => l.invoiceId === invoice.id);
    expect(billedLine).toBeTruthy();
    expect(billedLine.status).toBe('Invoiced');
  });
});
