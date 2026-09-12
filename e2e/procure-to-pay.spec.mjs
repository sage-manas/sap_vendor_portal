import { test, expect } from '@playwright/test';
import { ACCOUNTS, api, ok, tokenFor, signIn, createTender } from './helpers.mjs';

// The eight procure-to-pay stages, end to end, on the mock SAP driver:
//
//   RFQ → bid → award → PO → ASN → GRN → invoice → payment
//
// backend/tests/lifecycle-e2e.test.js already walks this through the API. What
// this adds is the browser: the supplier's own screens are checked at each
// stage, so the frontend and the backend have to agree on the shape of every
// document — the one thing a stubbed-fetch component test cannot prove.
//
// Where a step is driven through the API rather than the UI it is because the
// screen belongs to a role this spec is not sitting in front of (the buyer's
// award, finance's payment run), or because there is no UI for it at all (the
// goods receipt, which the mock warehouse posts on a timer). Every such step
// is marked.

const money = (value) => Number(value || 0);

test.describe('procure to pay, on the mock SAP driver', () => {
  // A cold Next build plus the backend's 10s goods-receipt simulator.
  test.slow();

  test('a tender becomes an order, a shipment, an invoice and a payment', async ({ page, request }) => {
    const buyerToken = await tokenFor(request, ACCOUNTS.buyer);
    const financeToken = await tokenFor(request, ACCOUNTS.finance);
    const supplierToken = await tokenFor(request, ACCOUNTS.supplierA);

    const buyer = api(request, buyerToken);
    const finance = api(request, financeToken);
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
    // The mock warehouse accepts 95% and rejects the rest on inspection, so
    // the invoice below bills the accepted quantity, not the shipped one.
    const accepted = money(grn.items[0].acceptedQuantity);
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThanOrEqual(quantity);

    // ------------------------------------------------------------ 7. Invoice
    const subTotal = Math.round(accepted * unitPrice * 100) / 100;
    const taxAmount = Math.round(subTotal * 0.18 * 100) / 100;
    const totalAmount = Math.round((subTotal + taxAmount) * 100) / 100;

    // POST /invoices answers { message, invoice }; POST /payments answers the
    // payment itself. Unwrapped here rather than smoothed over in the helper,
    // so the difference stays visible.
    const { invoice } = ok(await supplier.post('/invoices', {
      grnId: grn.id,
      invoiceNumber: `E2E/${Date.now()}`,
      invoiceDate: new Date().toISOString(),
      subTotal,
      taxAmount,
      totalAmount,
      items: [{
        line: 10,
        materialCode: 'MAT-E2E-1',
        description: 'Hex bolts M8',
        quantity: accepted,
        unitPrice,
        amount: subTotal,
      }],
    }));
    expect(invoice.id).toMatch(/^INV-/);

    // [UI · supplier] The invoice they just raised is on their ledger.
    await page.goto('/invoices');
    await expect(page.getByText(invoice.id).first()).toBeVisible({ timeout: 30_000 });

    // ------------------------------------------------------------ 8. Payment
    // [API · finance] The payment run is finance's screen, not the supplier's.
    const tds = Math.round(subTotal * 0.01 * 100) / 100;
    const payment = ok(await finance.post('/payments', {
      vendorId: ACCOUNTS.supplierA.vendorId,
      invoiceId: invoice.id,
      poId,
      grossAmount: totalAmount,
      tdsDeducted: tds,
      netAmount: Math.round((totalAmount - tds) * 100) / 100,
      paymentDate: new Date().toISOString(),
      utrCode: `UTRE2E${Date.now()}`,
      paymentMethod: 'NEFT',
    }));
    expect(payment.id).toMatch(/^PMT-/);

    // [UI · supplier] The last stage the supplier actually cares about: the
    // money arrived, and their screen says so.
    await page.goto('/payments');
    await expect(page.getByText(payment.utrCode).first()).toBeVisible({ timeout: 30_000 });

    // --- The trail holds together -------------------------------------------
    const finalPo = ok(await supplier.get(`/pos/${poId}`));
    expect(finalPo.fromRfqId).toBe(rfq.id);

    const finalRfq = ok(await buyer.get(`/rfqs/${rfq.id}`));
    expect(finalRfq.status).toBe('Awarded');
    expect(finalRfq.convertedPoId).toBe(poId);
  });
});
