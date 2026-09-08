const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createAdminUser } = require('./helpers');
const { prisma } = require('../db/prisma');
const { PO_INCLUDE, formatPo } = require('../db/poHelpers');
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
      plant: '1000',
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

// Reassembled into the same nested { items: [{ invoicePlan: {...} }] } shape
// controllers/po.controller.js's formatPo() produces, since InvoicePlan/
// InvoicePlanLine are relational tables now, not embedded subdocuments.
const readPO = async (id) => {
  const po = await runWithTenant('CLT-0001', () => prisma.purchaseOrder.findFirst({ where: { id }, include: PO_INCLUDE }));
  return po && formatPo(po);
};

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
    const { token, vendor } = await registerVendor(app, { vendorId: 'vendor_plan_5', gstin: '27AAAAA1005A1Z1' }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: 'plan-admin-5@example.com' });
    await seedPO({ id: 'PO-PLAN-5', vendorId: vendor.vendorId });
    await configure(adminToken, 'PO-PLAN-5', 10, partialBody);

    await request(app).post('/api/invoices/plan').set('Authorization', `Bearer ${token}`).send({
      poId: 'PO-PLAN-5', line: 10, planLineNumber: 10, invoiceNumber: 'V/2026/1', invoiceDate: '2026-02-01',
    });

    const removed = await request(app)
      .delete('/api/pos/PO-PLAN-5/items/10/invoice-plan')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(removed.status).toBe(400);
    expect(removed.body.error).toMatch(/already been invoiced/);
  });
});

describe('POST /api/invoices/plan', () => {
  const setup = async (suffix) => {
    // Each `it` starts from a clean database, but a test that calls setup twice
    // registers two suppliers into the same one — so the email has to vary too,
    // not only the vendor id and GSTIN.
    const { token, vendor } = await registerVendor(app, {
      vendorId: `vendor_planinv_${suffix}`,
      gstin: `27AAAAA20${suffix}A1Z1`,
      email: `planinv-${suffix}@example.com`,
    }, { onboarded: true });
    const { token: adminToken } = await createAdminUser({ email: `planinv-admin-${suffix}@example.com` });
    const poId = `PO-PLANINV-${suffix}`;
    await seedPO({ id: poId, vendorId: vendor.vendorId });
    await request(app).put(`/api/pos/${poId}/items/10/invoice-plan`).set('Authorization', `Bearer ${adminToken}`).send({
      type: 'Partial',
      milestones: [
        { settlementDate: '2020-01-01', percentage: 40, description: 'On order' },
        { settlementDate: '2099-01-01', percentage: 60, description: 'On commissioning' },
      ],
    });
    return { token, adminToken, poId, vendor };
  };

  it('bills the amount the plan says, not one the supplier supplies', async () => {
    const { token, poId } = await setup('01');

    const res = await request(app).post('/api/invoices/plan').set('Authorization', `Bearer ${token}`).send({
      poId, line: 10, planLineNumber: 10, invoiceNumber: 'V/2026/9', invoiceDate: '2026-02-01',
      // Not a field this endpoint accepts — the plan sets the amount.
      subTotal: 999999,
    });

    expect(res.status).toBe(201);
    expect(res.body.invoice.subTotal).toBe(20000);
    expect(res.body.invoice.taxAmount).toBe(3600);
    expect(res.body.invoice.totalAmount).toBe(23600);
    expect(res.body.invoice.grnId).toBeFalsy();
    expect(res.body.invoice.invoicePlanRef).toMatchObject({ line: 10, planLineNumber: 10, planType: 'Partial' });

    const po = await readPO(poId);
    const planLine = po.items[0].invoicePlan.lines[0];
    expect(planLine.status).toBe('Invoiced');
    expect(planLine.invoiceNumber).toBe('V/2026/9');
    // A single instalment does not finish the order.
    expect(po.status).toBe('Open');
  });

  it('will not bill an instalment before its settlement date', async () => {
    const { token, poId } = await setup('02');

    const res = await request(app).post('/api/invoices/plan').set('Authorization', `Bearer ${token}`).send({
      poId, line: 10, planLineNumber: 20, invoiceNumber: 'V/2026/10', invoiceDate: '2026-02-01',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be invoiced until its settlement date/);
  });

  it('will not bill the same instalment twice, or one the buyer has blocked', async () => {
    const { token, adminToken, poId } = await setup('03');
    const bill = (invoiceNumber) => request(app).post('/api/invoices/plan').set('Authorization', `Bearer ${token}`).send({
      poId, line: 10, planLineNumber: 10, invoiceNumber, invoiceDate: '2026-02-01',
    });

    expect((await bill('V/2026/11')).status).toBe(201);
    expect((await bill('V/2026/12')).status).toBe(400);
    expect(await runWithTenant('CLT-0001', () => prisma.invoice.count({ where: { poId } }))).toBe(1);

    const { poId: blockedPoId, token: blockedToken } = await setup('04');
    await request(app).put(`/api/pos/${blockedPoId}/items/10/invoice-plan/lines/10/block`)
      .set('Authorization', `Bearer ${adminToken}`).send({ blocked: true });

    const blocked = await request(app).post('/api/invoices/plan').set('Authorization', `Bearer ${blockedToken}`).send({
      poId: blockedPoId, line: 10, planLineNumber: 10, invoiceNumber: 'V/2026/13', invoiceDate: '2026-02-01',
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/billing-blocked/);
  });

  it('rejects a plan invoice against a line that has no plan', async () => {
    const { token, poId } = await setup('05');

    const res = await request(app).post('/api/invoices/plan').set('Authorization', `Bearer ${token}`).send({
      poId, line: 20, planLineNumber: 10, invoiceNumber: 'V/2026/14', invoiceDate: '2026-02-01',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no invoicing plan/);
  });
});
