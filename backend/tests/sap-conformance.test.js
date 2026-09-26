// Phase 8: the conformance suite that runs the SapAdapter contract against a
// live driver and reports pass/fail per method. Verified here against the
// mock driver (must pass everything), the ecc_rfc skeleton (must report
// not_implemented for everything but connectivity), and s4_odata (now
// implemented against the real OData APIs — without a reachable gateway it
// reports connectivity checks as "passed" with ok:false in their payload,
// and every write it genuinely attempts as "failed" rather than
// "not_implemented"; a method with no confirmed SAP endpoint at all, like
// vendorReject, still reports its own honest "not_implemented") — the same
// tool `scripts/sap-conformance.js` points at a real sandbox once one exists.
const { prisma } = require('../db/prisma');
const { runWithTenant, withoutTenantScope } = require('../utils/tenantContext');
const { METHOD_NAMES, DEFERRED_METHODS, SAP_METHODS } = require('../sap/contract');
const { buildTransientAdapter, invalidateSapAdapter } = require('../sap');
const { runConformanceSuite } = require('../sap/conformance/runner');
const { FIXTURES } = require('../sap/conformance/fixtures');
const { seedClient } = require('./helpers');

beforeEach(() => invalidateSapAdapter());

describe('the conformance suite', () => {
  it('passes every method against the mock driver, bar the ones it must not run', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} });

    const report = await runConformanceSuite({ adapter, clientId: 'CLT-0001' });

    expect(report.driver).toBe('mock');
    expect(report.results).toHaveLength(METHOD_NAMES.length);

    // A method the contract marks  is skipped, not run — see
    // runner.js. Today that is poAssetCreate (it would create a real purchase
    // order) and vendorBankUpdate (it would repoint a real vendor's payout
    // account). Derived from the contract rather than hardcoded so
    // adding one does not quietly leave this assertion measuring the wrong
    // thing. Note this is NOT "every method without a fixture": most reads need
    // no arguments and are deliberately fixture-less but still exercised.
    const skippable = METHOD_NAMES.filter((method) => (SAP_METHODS[method].createsDocument || SAP_METHODS[method].changesMasterData));
    expect(skippable).toEqual(['vendorBankUpdate', 'poAssetCreate']);

    const notSkipped = report.results.filter((r) => r.status !== 'skipped');
    expect(notSkipped.every((r) => r.status === 'passed')).toBe(true);
    expect(report.summary).toEqual({
      passed: METHOD_NAMES.length - skippable.length,
      skipped: skippable.length,
    });
  });

  it('says why a skipped method was skipped, rather than marking a working driver red', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} });

    const report = await runConformanceSuite({ adapter, clientId: 'CLT-0001' });
    const skipped = report.results.find((r) => r.method === 'poAssetCreate');

    expect(skipped.status).toBe('skipped');
    expect(skipped.error).toMatch(/not safe to exercise against a live system/);
  });

  it('writes no SapLog entry for a skipped method — nothing reached SAP', async () => {
    const adapter = buildTransientAdapter({ clientId: 'CLT-0001', driver: 'mock', config: {}, secrets: {} });

    await runConformanceSuite({ adapter, clientId: 'CLT-0001', methods: ['poAssetCreate'] });

    const logged = await runWithTenant('CLT-0001', () => prisma.sapLog.count({}));
    expect(logged).toBe(0);
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

    // A createsDocument (or changesMasterData) method is skipped before the driver is ever consulted,
    // so it reports 'skipped' here rather than 'not_implemented' — the runner
    // never asked ecc_rfc whether it could do it. Excluded explicitly rather
    // than loosened to "not failed", so a genuine regression still shows.
    const skipped = METHOD_NAMES.filter((method) => (SAP_METHODS[method].createsDocument || SAP_METHODS[method].changesMasterData));
    const rest = report.results.filter((r) =>
      !['testConnection', 'health'].includes(r.method) && !skipped.includes(r.method));
    expect(rest.every((r) => r.status === 'not_implemented')).toBe(true);
    expect(report.summary.not_implemented).toBe(METHOD_NAMES.length - 2 - skipped.length);
    expect(report.summary.skipped).toBe(skipped.length);
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
    for (const method of ['vendorVerifyKyc', 'poAcknowledge']) {
      expect(byMethod[method].status).toBe('passed');
    }

    // vendorReject has no confirmed SAP endpoint (issue #59) and, unlike
    // vendorVerifyKyc, VENDOR_REJECT is registered as a real OData transaction
    // — logging from here would claim a call that never happened. It falls
    // through to the skeleton's honest not_implemented instead.
    expect(byMethod.vendorReject.status).toBe('not_implemented');

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
    // A createsDocument (or changesMasterData) method is skipped, so it writes nothing — it would
    // otherwise be counted here as a logged method that never ran.
    const loggedMethods = METHOD_NAMES.filter((method) =>
      SAP_METHODS[method].logged !== false && !(SAP_METHODS[method].createsDocument || SAP_METHODS[method].changesMasterData));
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
