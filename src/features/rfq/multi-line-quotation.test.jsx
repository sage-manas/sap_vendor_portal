import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import RfqsPage from '@/app/rfqs/page';

// The Submit Quotation form used to send a price for exactly one "selected"
// line no matter how many lines the RFQ actually had — submitBid refuses a
// bid missing any line's price, so a real multi-line RFQ (like 6000000074,
// discovered from SAP with 3 lines) could never be quoted through this form
// at all. Every line now gets its own price input, all sent together.

const MULTI_LINE_RFQ = {
  id: 'RFQ-2026-007', description: 'Multi-line testing order', status: 'Bidding Open', deadlineDate: null,
  currency: 'INR', rfqType: 'AN', createdDate: '2026-09-23T00:00:00.000Z', sapDocNumber: '6000000074',
  items: [
    { line: 10, materialCode: 'MAT-0032', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, uom: 'KG', targetPrice: null },
    { line: 20, materialCode: 'MAT-0033', description: 'NEW MAT TESTING SERILISED PROCREMENT', quantity: 5, uom: 'PC', targetPrice: null },
    { line: 30, materialCode: 'MAT-0034', description: 'NEW MATERIAL SAGE TESTING 2', quantity: 10, uom: 'KG', targetPrice: null },
  ],
  invitedVendors: [{ id: 'VND-00001', name: 'Test Supplier Pvt Ltd', status: 'Pending', rating: null }],
  bids: [],
};

const withRfq = {
  ...EMPTY_SUPPLIER_API,
  'GET /rfqs': { rfqs: [MULTI_LINE_RFQ], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
};

const field = (label) => screen.getByLabelText(label, { exact: false });
const unitPriceField = (line) => screen.getByLabelText(`Unit price (₹) for line ${line}`, { exact: false });

const openQuotationTab = async (user) => {
  const tab = (await screen.findAllByRole('button', { name: /^Submit Quotation$/i }))
    .find((button) => button.getAttribute('type') !== 'submit');
  await user.click(tab);
  await waitFor(() => expect(screen.getByLabelText('Choose a request')).toBeInTheDocument(), { timeout: 4000 });
};

const submitForm = (user) => user.click(
  screen.getAllByRole('button', { name: /^Submit Quotation$/i })
    .find((button) => button.getAttribute('type') === 'submit')
);

const renderRfqs = (api = withRfq) =>
  renderWithPortal(<RfqsPage />, { plane: 'supplier', route: '/rfqs', api });

describe('quoting a multi-line RFQ', () => {
  it('shows one price input per line, not one shared field', async () => {
    const user = userEvent.setup();
    renderRfqs();
    await openQuotationTab(user);

    await user.selectOptions(screen.getByLabelText('Choose a request'), 'RFQ-2026-007');

    expect(await screen.findByLabelText('Unit price (₹) for line 10', { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText('Unit price (₹) for line 20', { exact: false })).toBeInTheDocument();
    expect(screen.getByLabelText('Unit price (₹) for line 30', { exact: false })).toBeInTheDocument();
  });

  it('refuses to submit when any line is left unpriced', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());
    const { apiMock } = renderRfqs();
    await openQuotationTab(user);

    await user.selectOptions(screen.getByLabelText('Choose a request'), 'RFQ-2026-007');
    await user.type(await screen.findByLabelText('Unit price (₹) for line 10', { exact: false }), '1000');
    await user.type(screen.getByLabelText('Unit price (₹) for line 20', { exact: false }), '150');
    // Line 30 deliberately left blank.
    await user.type(field('Delivery lead time (days)'), '{selectall}14');
    await user.type(field('Validity date'), '{selectall}2099-06-30');

    await submitForm(user);

    await waitFor(() => expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-007/bid')).toHaveLength(0));
    expect(screen.getByLabelText('Unit price (₹) for line 30', { exact: false })).toBeInvalid();
  });

  it('sends every line\'s price in one bid — the fix for RFQ 6000000074', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());
    const { apiMock } = renderRfqs({
      ...withRfq,
      'POST /rfqs/RFQ-2026-007/bid': { message: 'Bid submitted successfully', bidsCount: 1 },
    });
    await openQuotationTab(user);

    await user.selectOptions(screen.getByLabelText('Choose a request'), 'RFQ-2026-007');
    await user.type(await screen.findByLabelText('Unit price (₹) for line 10', { exact: false }), '1000');
    await user.type(screen.getByLabelText('Unit price (₹) for line 20', { exact: false }), '150');
    await user.type(screen.getByLabelText('Unit price (₹) for line 30', { exact: false }), '10');
    await user.clear(field('Delivery lead time (days)'));
    await user.type(field('Delivery lead time (days)'), '14');
    await user.clear(field('Validity date'));
    await user.type(field('Validity date'), '2099-06-30');

    await submitForm(user);

    await waitFor(() => expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-007/bid')).toHaveLength(1));
    const body = apiMock.lastBody('POST', '/rfqs/RFQ-2026-007/bid');
    expect(body.unitPrices).toEqual({ 10: 1000, 20: 150, 30: 10 });
  });
});
