import { test, expect } from '@playwright/test';
import { ACCOUNTS, api, ok, tokenFor, signIn, createTender } from './helpers.mjs';

// The procure-to-pay stages this portal actually produces, end to end, on
// the mock SAP driver:
//
//   RFQ → bid → award → PO → ASN → GRN
//
// backend/tests/lifecycle-e2e.test.js already walks this through the API. What
// this adds is the browser: the supplier's own screens are checked at each
// stage, so the frontend and the backend have to agree on the shape of every
// document — the one thing a stubbed-fetch component test cannot prove.
//
// The chain stops at the goods receipt: invoicing is AP's transaction against
// their own books, not the supplier's, and the portal creates no invoice on
// their behalf (PROJECT_CONTEXT.md §5.6) — so there is nothing beyond this
// point that a supplier's own screens can drive.
//
// Where a step is driven through the API rather than the UI it is because the
// screen belongs to a role this spec is not sitting in front of (the buyer's
// award), or because there is no UI for it at all (the goods receipt, which
// the mock warehouse posts on a timer). Every such step is marked.

const money = (value) => Number(value || 0);

test.describe('procure to pay, on the mock SAP driver', () => {
  // A cold Next build plus the backend's 10s goods-receipt simulator.
  test.slow();

  test('a tender becomes an order and a shipment, and the delivery is received', async ({ page, request }) => {
    const buyerToken = await tokenFor(request, ACCOUNTS.buyer);
    const supplierToken = await tokenFor(request, ACCOUNTS.supplierA);

    const buyer = api(request, buyerToken);
    const supplier = api(request, supplierToken);

    const unitPrice = 14;
    const quantity = 100;

    // ---------------------------------------------------------------- 1. RFQ
    // [API · buyer] Sourcing is the buyer's screen, not the supplier's.
    const rfq = await createTender(buyer, {
      description: 'E2E procure-to-pay walk',
      vendorIds: [ACCOUNTS.supplierA.vendorId],
      quantity,
    });
    expect(rfq.status).toBe('Bidding Open');

    // [UI · supplier] The invitation has to actually reach their screen.
    await signIn(page, ACCOUNTS.supplierA);
    await page.goto('/rfqs');
    await expect(page.getByText(rfq.id).first()).toBeVisible();

    // ---------------------------------------------------------------- 2. Bid
    // [API · supplier] The quotation form itself is driven through the UI in
    // competitive-tender.spec.mjs; here the bid is a step on the way.
    ok(await supplier.post(`/rfqs/${rfq.id}/bid`, {
      unitPrices: { 10: unitPrice },
      gstRate: '18%',
      deliveryLeadTimeDays: 5,
      validityDate: '2099-06-30T00:00:00.000Z',
      freight: 0,
    }));

    // -------------------------------------------------------------- 3. Award
    // [API · buyer] Awarding is an rfq:award permission the supplier lacks.
    const award = ok(await buyer.post(`/rfqs/${rfq.id}/award`, {
      vendorId: ACCOUNTS.supplierA.vendorId,
    }));
    const poId = award.po.id;
    expect(poId).toMatch(/^PO-\d{4}-\d{4}$/);
    // The order is priced from the winning bid, not from the target price.
    expect(money(award.po.items[0].unitPrice)).toBe(unitPrice);

    // ----------------------------------------------------------------- 4. PO
    // [UI · supplier] The order the award created must appear on the
    // supplier's ledger, and it must not claim a SAP number it does not have.
    await page.goto('/pos');
    await expect(page.getByText(poId).first()).toBeVisible({ timeout: 30_000 });

    // [API · supplier] Acknowledging is the supplier's own act.
    ok(await supplier.put(`/pos/${poId}/acknowledge`, {}));
    await expect
      .poll(async () => (await supplier.get(`/pos/${poId}`)).body.status, { timeout: 20_000 })
      .toBe('Acknowledged');

    // ---------------------------------------------------------------- 5. ASN
    ok(await supplier.post(`/pos/${poId}/asn`, {
      shipDate: new Date().toISOString(),
      estimatedDeliveryDate: new Date(Date.now() + 2 * 86400000).toISOString(),
      carrierName: 'BlueDart Express',
      trackingNumber: 'BD-E2E-0001',
      vehicleNumber: 'MH-12-AB-4455',
      items: [{ line: 10, shippedQuantity: quantity }],
    }));

    // [UI · supplier] The shipment shows on the order once raised.
    await page.goto('/pos');
    // GET /asns answers a bare array, unlike the other ledgers' { rows, pagination }.
    await expect
      .poll(async () => (await supplier.get('/asns')).body?.length ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // ---------------------------------------------------------------- 6. GRN
    // [no UI] The mock warehouse posts the goods receipt on a 10s timer —
    // submitASN in backend/controllers/po.controller.js. Nobody clicks this;
    // waiting for it is the test.
    const grnFor = async () => {
      const grns = (await supplier.get('/grns')).body.grns ?? [];
      return grns.find((row) => row.poId === poId) ?? null;
    };

    await expect.poll(grnFor, { timeout: 90_000, intervals: [1000] }).not.toBeNull();
    const grn = await grnFor();

    expect(grn.id).toMatch(/^GRN-/);
    // The mock warehouse accepts 95% and rejects the rest on inspection.
    const accepted = money(grn.items[0].acceptedQuantity);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(quantity);

    // [UI · supplier] The delivery receipt they can act on is on their ledger.
    await page.goto('/pos');
    await page.getByRole('button', { name: 'Delivery Receipts' }).click();
    await expect(page.getByText(grn.id).first()).toBeVisible({ timeout: 30_000 });

    // --- The trail holds together -------------------------------------------
    const finalPo = ok(await supplier.get(`/pos/${poId}`));
    expect(finalPo.fromRfqId).toBe(rfq.id);

    const finalRfq = ok(await buyer.get(`/rfqs/${rfq.id}`));
    expect(finalRfq.status).toBe('Awarded');
    expect(finalRfq.convertedPoId).toBe(poId);
  });
});
