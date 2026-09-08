const request = require('supertest');
const buildTestApp = require('./testApp');
const { prisma } = require('../db/prisma');
const { registerVendor, createTenantUser, asTenant } = require('./helpers');
const { ROLES } = require('../config/roles');
const {
  fiscalYearOf, fiscalQuarterOf, fiscalYearLabel, fiscalQuarterLabel,
} = require('../utils/fiscalPeriod');

const app = buildTestApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });

describe('the Indian fiscal calendar', () => {
  it.each([
    ['2026-04-01', 2026, 'Q1'],
    ['2026-06-30', 2026, 'Q1'],
    ['2026-07-01', 2026, 'Q2'],
    ['2026-10-01', 2026, 'Q3'],
    ['2027-01-01', 2026, 'Q4'],
    ['2027-03-31', 2026, 'Q4'],
    ['2027-04-01', 2027, 'Q1'],
  ])('files %s into FY%s %s', (date, year, quarter) => {
    expect(fiscalYearOf(date)).toBe(year);
    expect(fiscalQuarterOf(date)).toBe(quarter);
  });

  it('labels a year the way a 26AS statement does', () => {
    expect(fiscalYearLabel(2025)).toBe('2025-26');
    expect(fiscalYearLabel(2029)).toBe('2029-30');
  });

  it('spells out the months, because Q1 alone is ambiguous', () => {
    expect(fiscalQuarterLabel('Q4')).toBe('Q4 (Jan - Mar)');
  });
});

describe('GET /api/payments/tds-summary', () => {
  // Payment.invoiceId/poId are real FKs now (an improvement over Mongoose,
  // which enforced neither) — a fixed PO-1/INV-1 pair is created once per
  // vendor so every seeded payment has something real to point at.
  const ensureInvoiceAndPo = (vendorId) => asTenant(async () => {
    await prisma.purchaseOrder.upsert({
      where: { clientId_id: { clientId: 'CLT-0001', id: 'PO-1' } },
      create: { id: 'PO-1', vendorId, status: 'Open' },
      update: {},
    });
    await prisma.invoice.upsert({
      where: { clientId_id: { clientId: 'CLT-0001', id: 'INV-1' } },
      create: {
        id: 'INV-1', poId: 'PO-1', vendorId, invoiceNumber: 'V-1', invoiceDate: new Date('2026-05-01'),
        status: 'Cleared', subTotal: 1000, taxAmount: 0, totalAmount: 1000,
        invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date('2026-05-01').toISOString() },
      },
      update: {},
    });
  });

  const seedPayment = async (vendorId, overrides) => {
    await ensureInvoiceAndPo(vendorId);
    return asTenant(() => prisma.payment.create({
      data: {
        id: `PMT-${Math.random().toString().slice(2, 8)}`,
        invoiceId: 'INV-1', poId: 'PO-1', vendorId,
        netAmount: 990, utrCode: 'UTR1', paymentDate: new Date('2026-05-10'),
        grossAmount: 1000, tdsDeducted: 10,
        ...overrides,
      },
    }));
  };

  it('groups a supplier’s deductions by fiscal quarter, not calendar quarter', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });

    // Same calendar quarter (Q1 Jan–Mar), two different fiscal quarters.
    await seedPayment(vendor.vendorId, { paymentDate: new Date('2027-02-10'), tdsDeducted: 100 });
    await seedPayment(vendor.vendorId, { paymentDate: new Date('2026-05-10'), tdsDeducted: 40 });
    await seedPayment(vendor.vendorId, { paymentDate: new Date('2026-06-20'), tdsDeducted: 60 });

    const res = await request(app).get('/api/payments/tds-summary').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.quarters).toHaveLength(2);

    const [latest, earlier] = res.body.quarters;
    expect(latest).toMatchObject({ fiscalYearLabel: '2026-27', quarter: 'Q4', taxWithheld: 100 });
    // The two Q1 payments are one row, summed.
    expect(earlier).toMatchObject({
      fiscalYearLabel: '2026-27', quarterLabel: 'Q1 (Apr - Jun)', taxWithheld: 100, paymentCount: 2,
    });
  });

  it('never claims a return was filed, and says who issues the certificate', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await seedPayment(vendor.vendorId, {});

    const res = await request(app).get('/api/payments/tds-summary').set(auth(token));

    // No row asserts a filing status, because the portal cannot know one — the
    // old screen rendered a hardcoded "Filed & Signed" badge against invented
    // amounts. The disclaimer may of course mention filing; the data may not.
    expect(JSON.stringify(res.body.quarters)).not.toMatch(/filed|signed|status/i);
    expect(res.body.disclaimer).toMatch(/issued by Finance/i);
  });

  it('leaves section and TAN null rather than inventing them', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await seedPayment(vendor.vendorId, {});

    const [row] = (await request(app).get('/api/payments/tds-summary').set(auth(token))).body.quarters;

    expect(row.section).toBeNull();
    expect(row.deductorTan).toBeNull();
  });

  it('reports a section and TAN once SAP has supplied them', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await seedPayment(vendor.vendorId, { tdsSection: '194C', deductorTan: 'MUMB12345A', deducteePan: 'AABCB1234F' });

    const [row] = (await request(app).get('/api/payments/tds-summary').set(auth(token))).body.quarters;

    expect(row).toMatchObject({ section: '194C', deductorTan: 'MUMB12345A', deducteePan: 'AABCB1234F' });
  });

  it('omits a quarter in which nothing was withheld', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await seedPayment(vendor.vendorId, { tdsDeducted: 0 });

    const res = await request(app).get('/api/payments/tds-summary').set(auth(token));

    expect(res.body.quarters).toEqual([]);
  });

  it('shows a supplier only their own deductions', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await seedPayment(vendor.vendorId, { tdsDeducted: 25 });
    await seedPayment('VND-99999', { tdsDeducted: 9999 });

    const [row] = (await request(app).get('/api/payments/tds-summary').set(auth(token))).body.quarters;

    expect(row.taxWithheld).toBe(25);
  });

  it('lets tenant finance staff see the whole tenant', async () => {
    const { vendor } = await registerVendor(app, {}, { onboarded: true });
    const { token: finance } = await createTenantUser({ role: ROLES.FINANCE });
    await seedPayment(vendor.vendorId, { tdsDeducted: 25 });
    await seedPayment('VND-99999', { tdsDeducted: 75 });

    const [row] = (await request(app).get('/api/payments/tds-summary').set(auth(finance))).body.quarters;

    expect(row.taxWithheld).toBe(100);
  });
});

describe('the tenant-wide TDS view must not blend vendor identities', () => {
  const ensureInvoiceAndPo = (vendorId, poId, invId) => require('./helpers').asTenant(async () => {
    const { prisma } = require('../db/prisma');
    await prisma.purchaseOrder.upsert({
      where: { clientId_id: { clientId: 'CLT-0001', id: poId } },
      create: { id: poId, vendorId, status: 'Open' },
      update: {},
    });
    await prisma.invoice.upsert({
      where: { clientId_id: { clientId: 'CLT-0001', id: invId } },
      create: {
        id: invId, poId, vendorId, invoiceNumber: `V-${invId}`, invoiceDate: new Date('2026-05-01'),
        status: 'Cleared', subTotal: 1000, taxAmount: 0, totalAmount: 1000,
        invoicePlanRef: { line: 10, planLineNumber: 1, planType: 'Periodic', settlementDate: new Date('2026-05-01').toISOString() },
      },
      update: {},
    });
  });

  const seedPaymentFor = async (vendorId, poId, invId, overrides) => {
    await ensureInvoiceAndPo(vendorId, poId, invId);
    return asTenant(() => prisma.payment.create({
      data: {
        id: `PMT-${Math.random().toString().slice(2, 8)}`,
        invoiceId: invId, poId, vendorId,
        netAmount: 990, utrCode: `UTR-${Math.random().toString().slice(2, 8)}`, paymentDate: new Date('2026-05-10'),
        grossAmount: 1000, tdsDeducted: 10,
        ...overrides,
      },
    }));
  };

  it('sums correctly across vendors but withholds a blended PAN/section/TAN as unattributable', async () => {
    const { token: finance } = await createTenantUser({ role: ROLES.FINANCE });

    await seedPaymentFor('VND-AAAA', 'PO-A', 'INV-A', {
      tdsDeducted: 25, tdsSection: '194C', deductorTan: 'MUMB12345A', deducteePan: 'PANFORAAAA',
    });
    await seedPaymentFor('VND-BBBB', 'PO-B', 'INV-B', {
      tdsDeducted: 75, tdsSection: '194C', deductorTan: 'MUMB12345A', deducteePan: 'PANFORBBBB',
    });

    const [row] = (await request(app).get('/api/payments/tds-summary').set(auth(finance))).body.quarters;

    // The sum is exactly what a finance overview needs and stays correct...
    expect(row.taxWithheld).toBe(100);
    expect(row.paymentCount).toBe(2);
    // ...but nothing here is honestly "this vendor's" PAN once two vendors
    // are folded into one row — showing either PAN attached to the combined
    // ₹100 would misrepresent whose deduction that total belongs to.
    expect(row.deducteePan).toBeNull();
    expect(row.section).toBeNull();
    expect(row.deductorTan).toBeNull();
  });

  it('still reports a single vendor’s PAN/section/TAN when a quarter has only one', async () => {
    const { token: finance } = await createTenantUser({ role: ROLES.FINANCE });

    await seedPaymentFor('VND-SOLO', 'PO-S', 'INV-S', {
      tdsDeducted: 25, tdsSection: '194C', deductorTan: 'MUMB12345A', deducteePan: 'PANFORSOLO',
    });

    const [row] = (await request(app).get('/api/payments/tds-summary').set(auth(finance))).body.quarters;

    expect(row.deducteePan).toBe('PANFORSOLO');
    expect(row.section).toBe('194C');
  });

  it('?byVendor=true breaks the same quarter out per supplier instead of blending it', async () => {
    const { token: finance } = await createTenantUser({ role: ROLES.FINANCE });

    await seedPaymentFor('VND-AAAA', 'PO-A2', 'INV-A2', { tdsDeducted: 25, deducteePan: 'PANFORAAAA' });
    await seedPaymentFor('VND-BBBB', 'PO-B2', 'INV-B2', { tdsDeducted: 75, deducteePan: 'PANFORBBBB' });

    const res = await request(app).get('/api/payments/tds-summary?byVendor=true').set(auth(finance));

    expect(res.body.quarters).toHaveLength(2);
    const byId = Object.fromEntries(res.body.quarters.map((r) => [r.vendorId, r]));
    expect(byId['VND-AAAA']).toMatchObject({ taxWithheld: 25, deducteePan: 'PANFORAAAA' });
    expect(byId['VND-BBBB']).toMatchObject({ taxWithheld: 75, deducteePan: 'PANFORBBBB' });
  });

  it('?byVendor=true is a no-op for a supplier calling their own summary — every row is already theirs', async () => {
    const { token, vendor } = await registerVendor(app, {}, { onboarded: true });
    await seedPaymentFor(vendor.vendorId, 'PO-SUP', 'INV-SUP', { tdsDeducted: 40 });

    const plain = await request(app).get('/api/payments/tds-summary').set(auth(token));
    const withParam = await request(app).get('/api/payments/tds-summary?byVendor=true').set(auth(token));

    expect(withParam.body.quarters[0].taxWithheld).toBe(plain.body.quarters[0].taxWithheld);
  });
});
