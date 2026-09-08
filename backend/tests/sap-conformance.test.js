// Phase 8: the conformance suite that runs the SapAdapter contract against a
// live driver and reports pass/fail per method. Verified here against the
// mock driver (must pass everything), the ecc_rfc skeleton (must report
// not_implemented for everything but connectivity), and s4_odata (now
// implemented against the real OData APIs — without a reachable gateway it
// reports connectivity checks as "passed" with ok:false in their payload,
// and every write as "failed" rather than "not_implemented", since it
// genuinely tried and could not reach anything) — the same tool
// `scripts/sap-conformance.js` points at a real sandbox once one exists.
const { prisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { METHOD_NAMES, DEFERRED_METHODS, SAP_METHODS } = require('../sap/contract');
const { buildTransientAdapter, invalidateSapAdapter } = require('../sap');
const { runConformanceSuite } = require('../sap/conformance/runner');
const { seedClient } = require('./helpers');

beforeEach(() => invalidateSapAdapter());

describe('the conformance suite', () => {
  it('passes every method against the mock driver', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} });

    const report = await runConformanceSuite({ adapter, clientId: 'CLT-0001' });

    expect(report.driver).toBe('mock');
    expect(report.results).toHaveLength(METHOD_NAMES.length);
    expect(report.results.every((r) => r.status === 'passed')).toBe(true);
    expect(report.summary).toEqual({ passed: METHOD_NAMES.length });
  });

  it('reports not_implemented for everything but connectivity on the ecc_rfc skeleton', async () => {
    // The breaker trips after 5 consecutive failures by default, which a
    // 17-method not_implemented skeleton would hit well before the end of
    // the run — masking the rest of the report behind `sap_circuit_open`.
    // A conformance run raises the threshold for its own duration so every
    // method gets an honest answer instead of the breaker's verdict on the
    // methods before it.
    const adapter = buildTransientAdapter({
      clientId: 'CLT-0001', driver: 'ecc_rfc', secrets: {},
      config: { breaker: { failureThreshold: METHOD_NAMES.length + 1 } },
    });

    const report = await runConformanceSuite({ adapter, clientId: 'CLT-0001', timeoutMs: 3000 });

    const byMethod = Object.fromEntries(report.results.map((r) => [r.method, r.status]));
    expect(byMethod.testConnection).toBe('passed');
    expect(byMethod.health).toBe('passed');

    const rest = report.results.filter((r) => !['testConnection', 'health'].includes(r.method));
    expect(rest.every((r) => r.status === 'not_implemented')).toBe(true);
    expect(report.summary.not_implemented).toBe(METHOD_NAMES.length - 2);
  });

  it('exercises real logic on s4_odata without a live gateway: bookkeeping-only methods pass, everything that has to reach SAP fails honestly', async () => {
    const adapter = buildTransientAdapter({
      clientId: 'CLT-0001', driver: 's4_odata', secrets: {},
      config: { breaker: { failureThreshold: METHOD_NAMES.length + 1 } },
    });

    const report = await runConformanceSuite({ adapter, clientId: 'CLT-0001', timeoutMs: 3000 });
    const byMethod = Object.fromEntries(report.results.map((r) => [r.method, r]));

    // testConnection/health resolve normally — they report unreachability in
    // their own payload (ok:false) rather than throwing.
    expect(byMethod.testConnection.status).toBe('passed');
    expect(byMethod.health.status).toBe('passed');

    // Bookkeeping-only methods (mirroring the mock: they log what the caller
    // already has rather than making a network call of their own) pass even
    // with no gateway configured — same as they would against a real one.
    for (const method of ['vendorVerifyKyc', 'vendorReject', 'poAcknowledge']) {
      expect(byMethod[method].status).toBe('passed');
    }

    // Methods that genuinely have to call SAP fail without a reachable
    // baseUrl — never the skeleton's untried not_implemented. There is no
    // invoiceCreate or deliveryCreate in the contract any more: the portal
    // reads from SAP and never writes a document into it.
    for (const method of ['vendorCreate']) {
      expect(byMethod[method].status).toBe('failed');
    }

    // Sourcing is no longer part of the contract at all — RFQs, bids and awards
    // are portal-internal, and what SAP holds is read back rather than written.
    for (const method of ['rfqCreate', 'rfqSubmitBid', 'infoRecordCreate', 'poInboundSync']) {
      expect(byMethod[method]).toBeUndefined();
    }

    // awaitGoodsReceipt's fixture PO has a sapPoNumber but no matching Vendor
    // row exists in this test's database, so it resolves "not found" on its
    // one attempt without ever reaching the network — nothing left to make it
    // answer inside this short a timeout except a longer one (a real gateway
    // wouldn't change that either, without a real vendor/PO to match).
    expect(byMethod.awaitGoodsReceipt.status).toBe('failed');
    expect(byMethod.awaitGoodsReceipt.error).toMatch(/timed out/);

    // awaitPaymentRun's fixture has neither a SAP vendor code nor a SAP PO
    // number, so — unlike a real "not yet" — it fails immediately with an
    // honest reason rather than waiting out the timeout.
    expect(byMethod.awaitPaymentRun.status).toBe('failed');
    expect(byMethod.awaitPaymentRun.error).toMatch(/cannot be matched in SAP/);
  });

  it('marks a method that never answers as failed rather than hanging forever', async () => {
    const adapter = {
      driver: 'stub',
      implemented: false,
      testConnection: () => new Promise(() => {}), // never resolves
    };

    const report = await runConformanceSuite({ adapter, clientId: 'CLT-0001', timeoutMs: 20, methods: ['testConnection'] });

    expect(report.results[0]).toMatchObject({ method: 'testConnection', status: 'failed' });
    expect(report.results[0].error).toMatch(/timed out/);
  });

  it('writes real SapLog entries for the tenant it ran against', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} });

    await runConformanceSuite({ adapter, clientId: 'CLT-0001' });
    // runConformanceSuite awaits each deferred method's one-shot probe to
    // completion (jobs runtime — see sap/conformance/runner.js), so its own
    // log entries are already written by the time it returns; no race to
    // wait out here any more.

    const logged = await runWithTenant('CLT-0001', () => prisma.sapLog.count({}));
    // Every contract method that declares itself logged writes at least one
    // entry. Derived from the contract rather than hardcoded: the unlogged set
    // is not just the two connectivity checks and poProvision any more — every
    // read-only cross-check added since (the catalogues, the MIRO/payment/RFQ/
    // PO-GRN/quotation displays) is unlogged too, and a fixed offset went stale
    // silently each time one landed.
    const loggedMethods = METHOD_NAMES.filter((method) => SAP_METHODS[method].logged !== false);
    expect(logged).toBeGreaterThanOrEqual(loggedMethods.length);
  });

  it('keeps one tenant’s conformance run out of another’s log', async () => {
    await seedClient({ clientId: 'CLT-0002', slug: 'rival', companyName: 'Rival' });
    const adapter = buildTransientAdapter({ clientId: 'CLT-0002', driver: 'mock', config: {}, secrets: {} });

    await runConformanceSuite({ adapter, clientId: 'CLT-0002' });

    const seenByOther = await runWithTenant('CLT-0001', () => prisma.sapLog.count({}));
    expect(seenByOther).toBe(0);
  });

  it('declares the same deferred methods the contract does', () => {
    expect(DEFERRED_METHODS).toEqual(
      expect.arrayContaining(['awaitGoodsReceipt', 'awaitPaymentRun']),
    );
  });
});
