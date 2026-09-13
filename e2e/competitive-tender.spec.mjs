import { test, expect } from '@playwright/test';
import { ACCOUNTS, api, ok, tokenFor, signIn, signOut, createTender } from './helpers.mjs';

// Two suppliers, one sealed tender.
//
// This is the spec issue #24 argued for: the two most serious defects in this
// repo were both trivially visible from the UI and invisible to the suite.
//   #17  an uninvited supplier could bid on any tender
//   #18  the first bid closed the tender, so the second supplier was refused
// Both are fixed; this is what keeps them fixed, through the browser and the
// real API rather than against a stub.

// Filling the quotation form the way a supplier does — and the way assistive
// technology reads it. getByLabel only resolves a control whose label is
// programmatically attached, so every use of it here doubles as a check that
// the field is announced with a name.
const quoteField = (page, label) => page.getByLabel(label);

const submitQuote = async (page, rfqId, { unitPrice, leadTimeDays }) => {
  // The tab and the form's submit button share a label; the tab is the one
  // that is not a submit control.
  await page.getByRole('button', { name: 'Submit Quotation', exact: true })
    .and(page.locator('button:not([type="submit"])')).click();

  // The tab shows a skeleton for a deliberate 800ms before the form appears.
  await expect(quoteField(page, 'Unit price (₹)')).toBeVisible();

  await page.getByLabel('Choose a request').selectOption(rfqId);
  await quoteField(page, 'Unit price (₹)').fill(String(unitPrice));
  await quoteField(page, 'Delivery lead time (days)').fill(String(leadTimeDays));
  await quoteField(page, 'Validity date').fill('2099-06-30');

  await page.locator('button[type="submit"]', { hasText: 'Submit Quotation' }).click();
};

test.describe('a competitive tender with two invited suppliers', () => {
  test('both suppliers can bid, and the buyer ranks two quotes', async ({ page, request }) => {
    const buyer = api(request, await tokenFor(request, ACCOUNTS.buyer));

    const rfq = await createTender(buyer, {
      description: 'E2E sealed tender — two invited suppliers',
      vendorIds: [ACCOUNTS.supplierA.vendorId, ACCOUNTS.supplierB.vendorId],
    });
    expect(rfq.status).toBe('Bidding Open');

    // --- Supplier A quotes, through the browser -----------------------------
    await signIn(page, ACCOUNTS.supplierA);
    await page.goto('/rfqs');
    await submitQuote(page, rfq.id, { unitPrice: 14, leadTimeDays: 7 });

    await expect
      .poll(async () => (await buyer.get(`/rfqs/${rfq.id}`)).body.bids?.length, { timeout: 20_000 })
      .toBe(1);

    // The tender must still be open. Before #18 it was not: the first bid
    // flipped the status and the second supplier was told bidding had closed.
    expect(ok(await buyer.get(`/rfqs/${rfq.id}`)).status).toBe('Bidding Open');

    // --- Supplier B quotes on the same tender -------------------------------
    await signOut(page);
    await signIn(page, ACCOUNTS.supplierB);
    await page.goto('/rfqs');
    await submitQuote(page, rfq.id, { unitPrice: 12, leadTimeDays: 5 });

    await expect
      .poll(async () => (await buyer.get(`/rfqs/${rfq.id}`)).body.bids?.length, { timeout: 20_000 })
      .toBe(2);

    // --- The buyer now has a field of two to rank ---------------------------
    const evaluation = ok(await buyer.get(`/rfqs/${rfq.id}/evaluate`)).evaluation;
    expect(evaluation).toHaveLength(2);

    // B is cheaper and faster, so B leads on the weighted score.
    expect(evaluation[0].vendorId).toBe(ACCOUNTS.supplierB.vendorId);
    expect(evaluation[0].weightedScore).toBeGreaterThan(evaluation[1].weightedScore);

    // Identical invitations, so neither supplier carries a rating advantage
    // the other was not given (#22).
    expect(evaluation[0].vendorRating).toBe(evaluation[1].vendorRating);
  });

  test('a supplier who was not invited cannot bid on the tender', async ({ request }) => {
    const buyer = api(request, await tokenFor(request, ACCOUNTS.buyer));
    const outsider = api(request, await tokenFor(request, ACCOUNTS.supplierB));

    const rfq = await createTender(buyer, {
      description: 'E2E sealed tender — supplier A only',
      vendorIds: [ACCOUNTS.supplierA.vendorId],
    });

    // Supplier B was not invited. There is no screen that offers this, which
    // is exactly why it is worth asserting against the API: the tender is
    // discoverable by guessing a sequential id.
    const refused = await outsider.post(`/rfqs/${rfq.id}/bid`, {
      unitPrices: { 10: 9 },
      gstRate: '18%',
      deliveryLeadTimeDays: 3,
      validityDate: '2099-06-30T00:00:00.000Z',
      freight: 0,
    });

    // 404, not 403: the API must not confirm a sealed tender exists to a
    // non-participant.
    expect(refused.status).toBe(404);

    // Nothing was recorded — neither a bid nor the invitation the old code
    // used to create on the caller's behalf.
    const stored = ok(await buyer.get(`/rfqs/${rfq.id}`));
    expect(stored.bids).toHaveLength(0);
    expect(stored.invitedVendors.map((v) => v.id)).toEqual([ACCOUNTS.supplierA.vendorId]);
  });

  test('a supplier sees only the tenders they were invited to', async ({ page, request }) => {
    const buyer = api(request, await tokenFor(request, ACCOUNTS.buyer));

    const theirs = await createTender(buyer, {
      description: 'E2E visible to supplier A',
      vendorIds: [ACCOUNTS.supplierA.vendorId],
    });
    const notTheirs = await createTender(buyer, {
      description: 'E2E visible to supplier B only',
      vendorIds: [ACCOUNTS.supplierB.vendorId],
    });

    await signIn(page, ACCOUNTS.supplierA);
    await page.goto('/rfqs');

    await expect(page.getByText(theirs.id).first()).toBeVisible();
    await expect(page.getByText(notTheirs.id)).toHaveCount(0);
  });
});
