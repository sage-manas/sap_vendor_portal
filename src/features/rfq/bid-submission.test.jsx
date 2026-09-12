import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import RfqsPage from '@/app/rfqs/page';

// The bid form carries money into a sealed tender, and it is the flow the two
// most serious defects in this repo (an uninvited supplier bidding, and the
// first bid closing the tender) both run through. This drives the real form:
// what the supplier types, what validation refuses, and the exact payload that
// reaches POST /rfqs/:id/bid.

const OPEN_RFQ = {
  id: 'RFQ-2026-001',
  description: 'Industrial fasteners bulk order',
  status: 'Bidding Open',
  deadlineDate: '2099-01-01T00:00:00.000Z',
  currency: 'INR',
  rfqType: 'AN',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [
    { line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, uom: 'EA', targetPrice: 12 },
  ],
  invitedVendors: [{ id: 'VND-00001', name: 'Test Supplier Pvt Ltd', status: 'Pending', rating: 90 }],
  bids: [],
};

const withRfq = {
  ...EMPTY_SUPPLIER_API,
  'GET /rfqs': { rfqs: [OPEN_RFQ], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
};

// The form's labels are not associated with their inputs (no htmlFor, no
// wrapping label), so getByLabelText cannot reach them — find the field by its
// visible label and take the control inside the same card.
const field = (label) => {
  const labelNode = screen.getByTitle(label);
  const card = labelNode.closest('div');
  const control = card.querySelector('input, select, textarea');
  if (!control) throw new Error(`No control in the "${label}" field`);
  return control;
};

// The tab shows a skeleton for a deliberate 800ms before the form appears
// (the tabLoading effect in RfqView), so this waits for a field rather than
// for the click.
const openQuotationTab = async (user) => {
  // The tab bar button and the form's submit button carry the same label, so
  // the tab is the one that is not a submit control.
  const tab = (await screen.findAllByRole('button', { name: /^Submit Quotation$/i }))
    .find((button) => button.getAttribute('type') !== 'submit');
  await user.click(tab);
  // The tab shows a skeleton for a deliberate 800ms before the form appears
  // (RfqView's tabLoading effect), so wait for a field rather than the click.
  await waitFor(() => expect(screen.getByTitle('Unit price (₹)')).toBeInTheDocument(),
    { timeout: 4000 });
};

const submitForm = (user) => user.click(
  screen.getAllByRole('button', { name: /^Submit Quotation$/i })
    .find((button) => button.getAttribute('type') === 'submit')
);

// The RFQ picker is a bare <select> above the field cards, not one of them.
const rfqSelect = () => document.querySelector('select');

// Everything the form marks required, filled the way a supplier would.
const fillQuote = async (user) => {
  await user.selectOptions(rfqSelect(), 'RFQ-2026-001');
  await user.clear(field('Unit price (₹)'));
  await user.type(field('Unit price (₹)'), '11.5');
  await user.clear(field('Delivery lead time (days)'));
  await user.type(field('Delivery lead time (days)'), '5');
  await user.clear(field('Validity date'));
  await user.type(field('Validity date'), '2099-06-30');
};

const renderRfqs = (api = withRfq) =>
  renderWithPortal(<RfqsPage />, { plane: 'supplier', route: '/rfqs', api });

describe('submitting a quotation', () => {
  it('sends nothing when the form is untouched', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());

    const { apiMock } = renderRfqs();
    await openQuotationTab(user);

    await submitForm(user);

    // The required attributes stop the submit before the handler runs, so the
    // assertion is simply that no quote reached the API.
    await waitFor(() => expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-001/bid')).toHaveLength(0));
  });

  it('refuses a zero unit price — no tender is quoted for free', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());

    const { apiMock } = renderRfqs();
    await openQuotationTab(user);

    await fillQuote(user);
    await user.clear(field('Unit price (₹)'));
    await user.type(field('Unit price (₹)'), '0');
    await submitForm(user);

    // Two rules agree here and the first one wins: the input declares
    // min="0.01", so the submit never reaches handleQuotationSubmit's own
    // `Number(unitPrice) <= 0` check. What matters either way is that nothing
    // was sent — asserted on the constraint and on the wire, because dropping
    // the attribute would quietly move the refusal to the (untested) handler.
    expect(field('Unit price (₹)')).toBeInvalid();
    expect(field('Unit price (₹)')).toHaveAttribute('min', '0.01');
    await waitFor(() => expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-001/bid')).toHaveLength(0));
  });

  it('sends the priced lines, GST rate and lead time the supplier entered', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());

    const { apiMock } = renderRfqs({
      ...withRfq,
      'POST /rfqs/RFQ-2026-001/bid': { message: 'Bid submitted successfully', bidsCount: 1 },
    });

    await openQuotationTab(user);

    await fillQuote(user);

    await submitForm(user);

    await waitFor(() =>
      expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-001/bid')).toHaveLength(1));

    const body = apiMock.lastBody('POST', '/rfqs/RFQ-2026-001/bid');
    expect(body).toMatchObject({
      unitPrices: { 10: 11.5 },
      gstRate: '18%',
      deliveryLeadTimeDays: 5,
    });
    expect(body.validityDate).toContain('2099-06-30');
  });

  it('keeps the typed quote when the server refuses it', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());

    // What an uninvited supplier now gets — the fix for the sealed-tender
    // defect answers 404 rather than silently creating an invitation.
    const { apiMock } = renderRfqs({
      ...withRfq,
      'POST /rfqs/RFQ-2026-001/bid': { status: 404, body: { error: 'RFQ not found' } },
    });

    await openQuotationTab(user);
    await fillQuote(user);

    await submitForm(user);

    await waitFor(() =>
      expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-001/bid')).toHaveLength(1));

    // A rejected submission must not clear the form: re-entering a whole quote
    // because the server said no is the difference between a retry and a
    // re-key.
    await waitFor(() => expect(field('Unit price (₹)')).toHaveValue(11.5));
  });
});
