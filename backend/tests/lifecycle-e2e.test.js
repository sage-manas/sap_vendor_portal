const request = require('supertest');
const buildTestApp = require('./testApp');
const { registerVendor, createTenantUser, seedClient, baseVendor, runDueJobs } = require('./helpers');

// One tenant runs a complete procurement cycle — RFQ → bid → award → PO →
// ASN → GRN → invoice → payment — on the mock driver, while a second tenant
// sits alongside doing the same thing. Every step asserts twice: that the step
// worked, and that the other tenant cannot see that it happened.
//
// This is the phase's acceptance test. It goes through the HTTP API rather than
// a browser: the isolation claim is about what the API answers, and a headless
// browser would test the same assertions through three more layers of chrome
// (ADR-0029).

const app = buildTestApp();

const TENANT_A = { clientId: 'CLT-0002', slug: 'northwind', companyName: 'Northwind Traders' };
const TENANT_B = { clientId: 'CLT-0003', slug: 'contoso', companyName: 'Contoso Supply' };

const futureDate = (days = 7) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

// A deferred SAP answer (the goods receipt, the payment run) now lands as a
// durable SapJob row (docs/04-sap-runtime-engineering-plan.md Phase 1) that
// nothing processes under test unless asked to — runDueJobs() is that ask.
// Poll the API the way the portal does rather than reaching into the
// database, driving the job runtime once per attempt rather than racing a
// live worker loop that isn't running.
const until = async (probe, what, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    await runDueJobs();
    const answer = await probe();
    if (answer) return answer;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// Everything one tenant needs to run a cycle: a buyer, a supplier, and the
// request helpers that sign as each.
const setUpTenant = async ({ clientId, slug, companyName }, seq) => {
  await seedClient({ clientId, slug, companyName });

  const supplier = await registerVendor(app, {
    clientId,
    vendorId: `vendor_${slug}`,
    email: `supplier@${slug}.example.com`,
    // Business identifiers are unique per tenant now, but these two accounts
    // are different companies, so they carry different ones anyway.
    gstin: `2${seq}AABCB1234F1Z5`,
    companyName: `${companyName} Supplier`,
    // The cycle this suite walks starts after onboarding: a supplier still in
    // Draft cannot reach any of it (middleware/requireOnboarded.js).
  }, { clientSlug: slug, onboarded: true });

  const buyer = await createTenantUser({
    role: 'buyer',
    clientId,
    email: `buyer@${slug}.example.com`,
  });

  const finance = await createTenantUser({
    role: 'finance',
    clientId,
    email: `finance@${slug}.example.com`,
  });

  const sign = (token) => (req) => req.set('Authorization', `Bearer ${token}`);

  return {
    clientId,
    slug,
    vendorId: supplier.vendor.vendorId,
    asSupplier: sign(supplier.token),
    asBuyer: sign(buyer.token),
    asFinance: sign(finance.token),
  };
};

// The whole cycle for one tenant, returning the documents it produced so the
// other tenant can be asked about them by id.
const runCycle = async (tenant) => {
  const { asBuyer, asSupplier, asFinance, vendorId } = tenant;

  // ── RFQ ──────────────────────────────────────────────────────────────
  const rfqRes = await asBuyer(request(app).post('/api/rfqs')).send({
    description: `Fasteners for ${tenant.slug}`,
    deadlineDate: futureDate(),
    items: [
      { line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, targetPrice: 12 },
    ],
    invitedVendors: [{ id: vendorId, name: 'Supplier', rating: 90 }],
  });
  expect(rfqRes.status).toBe(201);
  const rfqId = rfqRes.body.id;

  // ── Bid ──────────────────────────────────────────────────────────────
  const bidRes = await asSupplier(request(app).post(`/api/rfqs/${rfqId}/bid`)).send({
    unitPrices: { 10: 11.5 },
    gstRate: '18%',
    deliveryLeadTimeDays: 5,
    validityDate: futureDate(30),
    freight: 500,
  });
  expect(bidRes.status).toBe(200);

  // ── Award → PO ───────────────────────────────────────────────────────
  const awardRes = await asBuyer(request(app).post(`/api/rfqs/${rfqId}/award`)).send({ vendorId });
  expect(awardRes.status).toBe(200);
  const poId = awardRes.body.po.id;

  const ackRes = await asSupplier(request(app).put(`/api/pos/${poId}/acknowledge`));
  expect(ackRes.status).toBe(200);

  // ── ASN → GRN ────────────────────────────────────────────────────────
  const asnRes = await asSupplier(request(app).post(`/api/pos/${poId}/asn`)).send({
    shipDate: new Date().toISOString(),
    estimatedDeliveryDate: futureDate(2),
    carrierName: 'BlueDart Express',
    trackingNumber: 'BD-100200',
    items: [{ line: 10, shippedQuantity: 100 }],
  });
  expect(asnRes.status).toBe(201);
  const asnId = asnRes.body.asn.id;

  // The mock warehouse answers on its own schedule (zero delay under test).
  const grn = await until(async () => {
    const res = await asSupplier(request(app).get('/api/grns'));
    return (res.body.grns || res.body || []).find((g) => g.poId === poId);
  }, `a goods receipt for ${poId}`);

  const accepted = grn.items[0].acceptedQuantity;
  expect(accepted).toBeGreaterThan(0);

  // ── Invoice ──────────────────────────────────────────────────────────
  const unitPrice = 11.5;
  const subTotal = Number((accepted * unitPrice).toFixed(2));
  const taxAmount = Number((subTotal * 0.18).toFixed(2));

  const invoiceRes = await asSupplier(request(app).post('/api/invoices')).send({
    grnId: grn.id,
    invoiceNumber: `INV-${tenant.slug}-001`,
    invoiceDate: new Date().toISOString(),
    subTotal,
    taxAmount,
    totalAmount: Number((subTotal + taxAmount).toFixed(2)),
    items: [{
      line: 10,
      materialCode: 'MAT-001',
      description: 'Hex bolts M8',
      quantity: accepted,
      unitPrice,
      amount: subTotal,
    }],
  });
  expect(invoiceRes.status).toBe(201);
  const invoiceId = invoiceRes.body.invoice?.id || invoiceRes.body.id;

  // ── Payment (F110) ───────────────────────────────────────────────────
  const payment = await until(async () => {
    const res = await asFinance(request(app).get('/api/payments'));
    return (res.body.payments || res.body || []).find((p) => p.invoiceId === invoiceId);
  }, `a payment run for ${invoiceId}`);

  expect(payment.utrCode).toBeTruthy();
  // Withholding applied, so the remittance is less than the invoice.
  expect(payment.netAmount).toBeLessThan(invoiceRes.body.invoice?.totalAmount ?? Infinity);

  return { rfqId, poId, asnId, grnId: grn.id, invoiceId, paymentId: payment.id };
};

describe('a full procurement cycle inside one tenant', () => {
  jest.setTimeout(60000);

  let a;
  let b;

  beforeEach(async () => {
    a = await setUpTenant(TENANT_A, 7);
    b = await setUpTenant(TENANT_B, 9);
  });

  it('carries RFQ → award → PO → ASN → GRN → invoice → payment on the mock driver', async () => {
    const docs = await runCycle(a);

    expect(docs.rfqId).toMatch(/^RFQ-\d{4}-\d{3}$/);
    expect(docs.poId).toMatch(/^PO-\d{4}-\d{4}$/);
    expect(docs.paymentId).toBeTruthy();
  });

  it('runs both tenants side by side, each numbering its own documents', async () => {
    const [first, second] = [await runCycle(a), await runCycle(b)];

    // Business ids are unique per tenant now (Phase 1), so two tenants running
    // their first cycle both get document number one — and that is correct.
    expect(second.rfqId).toBe(first.rfqId);
    expect(second.poId).toBe(first.poId);
  });

  it('shows neither tenant a single document of the other', async () => {
    const docs = await runCycle(a);

    // Every collection in the cycle, asked for by A's id with B's session.
    const lookups = [
      ['/api/rfqs', docs.rfqId],
      ['/api/pos', docs.poId],
      ['/api/grns', docs.grnId],
      ['/api/invoices', docs.invoiceId],
      ['/api/payments', docs.paymentId],
    ];

    for (const [collection, id] of lookups) {
      const res = await b.asBuyer(request(app).get(`${collection}/${id}`));
      // 404, never 403: the API does not confirm that another tenant's
      // document exists (ADR-0003).
      expect(res.status).toBe(404);
    }
  });

  it('leaves the other tenant with empty lists, not filtered ones', async () => {
    await runCycle(a);

    // Each list read the widest way its own caller can ask: `all=true` is the
    // buyer's whole-workspace view of RFQs, and the shipment list is only ever
    // asked for one supplier at a time, so that one is asked as the supplier.
    const reads = [
      ['/api/rfqs?all=true', b.asBuyer],
      ['/api/pos', b.asBuyer],
      ['/api/grns', b.asBuyer],
      ['/api/invoices', b.asBuyer],
      ['/api/payments', b.asBuyer],
      [`/api/asns?vendorId=${b.vendorId}`, b.asSupplier],
    ];

    for (const [collection, as] of reads) {
      const res = await as(request(app).get(collection));
      expect(res.status).toBe(200);
      const rows = res.body.rfqs || res.body.pos || res.body.asns || res.body.grns
        || res.body.invoices || res.body.payments || res.body;
      expect(rows).toHaveLength(0);
    }
  });

  it('does not let the other tenant sign in as this tenant supplier', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('host', `${TENANT_B.slug}.vendorconnect.io`)
      .send({ vendorIdOrEmail: `supplier@${TENANT_A.slug}.example.com`, password: baseVendor.password });

    expect(res.status).toBe(401);
  });
});
