import { test, expect } from '@playwright/test';
import { ACCOUNTS, api, ok, tokenFor, signIn, signOut, createTender } from './helpers.mjs';

// The two stories a demo of this product tells, each driven through the
// screens a person actually uses.
//
// procure-to-pay.spec.mjs proves the documents chain together, but it moves the
// supplier's own steps through the API. That is exactly where this repo's
// demo-breaking defects were hiding: a registration form that could not be
// finished offline, and a job worker that exited after one tick so goods
// receipts never arrived. So here every step a supplier or the client admin
// takes is a click, a keystroke or a file chosen in a browser. The only API
// calls are the ones made as a role whose screen this is not (the buyer's
// award, finance's payment run) and read-backs that check what was stored.

const pdf = (name) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'),
});

// A GSTIN/PAN pair unique to this run, so the spec can run against a database
// that already holds the last run's supplier.
const uniqueIdentity = () => {
  const digits = String(Date.now()).slice(-4);
  const letters = digits.split('').map((d) => 'ABCDEFGHIJ'[Number(d)]).join('');
  // PAN is five letters, four digits, one letter; the GSTIN embeds it.
  const pan = `P${letters}${digits}K`;
  return {
    company: `Sahyadri Fasteners ${digits} Pvt Ltd`,
    email: `accounts${digits}@sahyadri-fasteners.test`,
    pan,
    gstin: `27${pan}1Z5`,
  };
};

test.describe('demo flows, through the UI', () => {
  test.slow();

  test('a new supplier registers, and the client admin approves them', async ({ page, request }) => {
    const who = uniqueIdentity();

    // The IFSC and PIN-code lookups are third-party calls from the browser.
    // Blocking them makes the run independent of the network and exercises the
    // manual-entry path a supplier behind a firewall gets.
    await page.route('https://ifsc.razorpay.com/**', (route) => route.abort());
    await page.route('https://api.postalpincode.in/**', (route) => route.abort());

    // --- Sign up ----------------------------------------------------------
    await page.goto('/sign-up');
    await page.getByLabel('Company Registered Name').fill(who.company);
    await page.getByLabel('Corporate Contact Email').fill(who.email);
    await page.getByLabel('Create Password').fill('Demo@12345');
    await page.getByLabel('GSTIN Number (India)').fill(who.gstin);
    await page.getByLabel('PAN Number').fill(who.pan);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL((url) => new URL(url).pathname === '/');

    // A supplier who has not registered is not shown a made-up account.
    await expect(page.getByText('Next Payment')).toHaveCount(0);
    await expect(page.getByText(/Draft/).first()).toBeVisible();

    // --- Step 1: company ----------------------------------------------------
    await page.goto('/registration');
    await page.getByLabel('Business type').selectOption({ index: 1 });
    await page.getByLabel('Street / area').fill('Plot 14, MIDC Bhosari');
    await page.getByLabel('City').fill('Pune');
    await page.getByRole('button', { name: 'Country', exact: true }).click();
    await page.getByRole('option', { name: /India/ }).first().click();
    await page.getByRole('button', { name: 'State / Region', exact: true }).click();
    await page.getByRole('option', { name: /Maharashtra/ }).first().click();
    await page.getByLabel('PIN code').fill('411026');
    await page.getByLabel('Mobile / phone').fill('+91 98220 11223');
    await page.getByRole('button', { name: 'Save & Continue' }).click();

    // --- Step 2: tax ----------------------------------------------------------
    await expect(page.getByLabel('GST Registration Type')).toBeVisible();
    await page.getByLabel('GST Registration Type').selectOption({ index: 1 });
    await page.getByLabel('TDS Section').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Save & Continue' }).click();

    // --- Step 3: bank ---------------------------------------------------------
    await expect(page.getByLabel('Account holder name')).toBeVisible();
    await page.getByLabel('Account holder name').fill(who.company);
    await page.getByLabel('Bank account number').fill('50100234567812');
    await page.getByLabel('IFSC code').fill('HDFC0000060');
    // The lookup was refused, so the two fields must open for typing.
    await expect(page.getByLabel('Bank name (auto-fetched)')).toBeEditable();
    await page.getByLabel('Bank name (auto-fetched)').fill('HDFC Bank');
    await page.getByLabel('Bank branch (auto-fetched)').fill('Bhosari, Pune');
    await page.getByLabel('Cancelled cheque copy').setInputFiles(pdf('cancelled-cheque.pdf'));
    await expect(page.getByText('cancelled-cheque.pdf')).toBeVisible();
    await page.getByRole('button', { name: 'Save & Continue' }).click();

    // --- Step 4: documents ----------------------------------------------------
    await page.getByLabel('PAN card copy').setInputFiles(pdf('pan-card.pdf'));
    await expect(page.getByText('pan-card.pdf')).toBeVisible();
    await page.getByLabel('GST certificate').setInputFiles(pdf('gst-certificate.pdf'));
    await expect(page.getByText('gst-certificate.pdf')).toBeVisible();
    await page.getByRole('button', { name: 'Submit Registration' }).click();

    // --- The client admin decides, in the workspace ---------------------------
    const admin = api(request, await tokenFor(request, ACCOUNTS.admin));
    await expect
      .poll(async () => {
        const { vendors = [] } = (await admin.get(`/vendors?search=${encodeURIComponent(who.email)}`)).body;
        return vendors[0]?.status;
      }, { timeout: 30_000 })
      .toMatch(/Under Review|Pending Approval|Submitted/);

    await signOut(page);
    await signIn(page, ACCOUNTS.admin, { expectPath: '/workspace' });
    await page.goto('/workspace/suppliers');
    const row = page.getByRole('row').filter({ hasText: who.company });
    await row.getByRole('button', { name: 'Approve' }).click();
    await expect(page.getByText(`${who.company} was approved`)).toBeVisible();

    const { vendors } = ok(await admin.get(`/vendors?search=${encodeURIComponent(who.email)}`));
    expect(vendors[0].status).toBe('Approved');
    // What the supplier typed is what was stored — including the bank
    // details entered by hand when the lookup was unavailable.
    const stored = ok(await admin.get(`/vendors/${vendors[0].vendorId}`));
    const profile = stored.vendor ?? stored;
    expect(profile.bankName).toBe('HDFC Bank');
    expect(profile.city).toBe('Pune');
  });

  test('a supplier acknowledges, ships and invoices an order, and sees the payment', async ({ page, request }) => {
    const buyer = api(request, await tokenFor(request, ACCOUNTS.buyer));
    const finance = api(request, await tokenFor(request, ACCOUNTS.finance));
    const supplier = api(request, await tokenFor(request, ACCOUNTS.supplierA));

    // [API · buyer] The order exists before the supplier's story starts.
    const rfq = await createTender(buyer, { description: 'Demo flow — hex bolts', vendorIds: [ACCOUNTS.supplierA.vendorId] });
    ok(await supplier.post(`/rfqs/${rfq.id}/bid`, {
      unitPrices: { 10: 14 }, gstRate: '18%', deliveryLeadTimeDays: 5, validityDate: '2099-06-30T00:00:00.000Z', freight: 0,
    }));
    const { po } = ok(await buyer.post(`/rfqs/${rfq.id}/award`, { vendorId: ACCOUNTS.supplierA.vendorId }));

    await signIn(page, ACCOUNTS.supplierA);

    // --- The dashboard tells the supplier there is an order to acknowledge ---
    await expect(page.getByText(new RegExp(`awaiting acknowledgement.*${po.id}`))).toBeVisible();

    // --- Acknowledge ----------------------------------------------------------
    await page.goto('/pos');
    await page.getByPlaceholder('PO # or material description...').fill(po.id);
    await page.getByRole('row').filter({ hasText: po.id }).getByRole('button', { name: 'View PO' }).click();
    await page.getByRole('button', { name: 'Acknowledge Purchase Order' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`${po.id}.*Acknowledged`) })).toBeVisible();

    // --- Ship -------------------------------------------------------------------
    await page.getByRole('button', { name: '2. Send shipment' }).click();
    // Nothing is invented on the supplier's behalf: the references start empty.
    await expect(page.getByLabel('Carrier / Transporter')).toHaveValue('');
    await expect(page.getByLabel('E-Way Bill Number')).toHaveValue('');
    await page.getByLabel('Carrier / Transporter').fill('Safexpress');
    await page.getByLabel('Vehicle / Tracking No.').fill('MH-14-KL-2211');
    await page.getByRole('button', { name: 'Submit Inbound Delivery' }).click();

    await expect.poll(async () => {
      const asns = (await supplier.get('/asns')).body ?? [];
      return asns.find((asn) => asn.poId === po.id) ?? null;
    }, { timeout: 20_000 }).toMatchObject({ carrierName: 'Safexpress', vehicleNumber: 'MH-14-KL-2211', trackingNumber: null });

    // --- The goods receipt arrives from the job worker --------------------------
    const grnFor = async () => ((await supplier.get('/grns')).body.grns ?? []).find((g) => g.poId === po.id) ?? null;
    await expect.poll(grnFor, { timeout: 90_000, intervals: [1000] }).not.toBeNull();
    const grn = await grnFor();

    // --- Invoice, from the screen -------------------------------------------------
    const invoiceNumber = `SF/26-27/${Date.now().toString().slice(-5)}`;
    await page.goto('/invoices');
    const receipt = page.locator('div').filter({ hasText: grn.id })
      .filter({ has: page.getByRole('button', { name: 'Create invoice' }) }).last();
    await receipt.getByRole('button', { name: 'Create invoice' }).click();
    await page.getByLabel('Your invoice number').fill(invoiceNumber);
    await page.getByLabel('Invoice Date').fill(new Date().toISOString().slice(0, 10));
    await page.getByRole('button', { name: 'Submit invoice' }).click();

    await expect.poll(async () => {
      const invoices = (await supplier.get('/invoices')).body.invoices ?? [];
      return invoices.find((inv) => inv.invoiceNumber === invoiceNumber) ?? null;
    }, { timeout: 20_000 }).not.toBeNull();
    const invoice = ((await supplier.get('/invoices')).body.invoices).find((inv) => inv.invoiceNumber === invoiceNumber);
    expect(invoice.grnId).toBe(grn.id);

    await page.goto('/invoices');
    await expect(page.getByRole('row').filter({ hasText: invoiceNumber })).toBeVisible();

    // --- [API · finance] The payment run, then the supplier sees the money --------
    const gross = Number(invoice.totalAmount);
    const tds = Math.round(Number(invoice.subTotal) * 0.01 * 100) / 100;
    const payment = ok(await finance.post('/payments', {
      vendorId: ACCOUNTS.supplierA.vendorId,
      invoiceId: invoice.id,
      poId: po.id,
      grossAmount: gross,
      tdsDeducted: tds,
      netAmount: Math.round((gross - tds) * 100) / 100,
      paymentDate: new Date().toISOString(),
      utrCode: `HDFCN${Date.now()}`,
      paymentMethod: 'NEFT',
    }));

    await page.goto('/payments');
    await expect(page.getByText(payment.utrCode).first()).toBeVisible({ timeout: 30_000 });
  });
});
