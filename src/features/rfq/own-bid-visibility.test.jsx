import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import RfqsPage from '@/app/rfqs/page';

// "Bid submitted successfully" used to be the only feedback a supplier ever
// saw — nothing afterward showed the price back to them anywhere in the
// portal: not the RFQ detail view, not the Submit Quotation form on a second
// visit. A supplier who submitted a real quote (RFQ 6000000072, ₹1000/line)
// had no way to confirm it had actually landed.

const ALREADY_QUOTED_RFQ = {
  id: 'RFQ-2026-005', description: 'Flange order', status: 'Bidding Open', deadlineDate: null,
  currency: 'INR', rfqType: 'AN', createdDate: '2026-09-23T00:00:00.000Z', sapDocNumber: '6000000072',
  items: [{ line: 10, materialCode: 'MAT-0032', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, uom: 'KG', targetPrice: null }],
  invitedVendors: [{ id: 'VND-00001', name: 'Test Supplier Pvt Ltd', status: 'Pending', rating: null }],
  bids: [{
    vendorId: 'VND-00001', vendorName: 'Test Supplier Pvt Ltd', unitPrices: { 10: 1000 },
    gstRate: '18%', freight: 0, deliveryLeadTimeDays: 7, validityDate: '2026-10-24T00:00:00.000Z',
    remarks: 'Quote Ref: N/A | Discount: 0% | Incoterms: EXW', submittedAt: '2026-09-24T11:31:29.316Z',
  }],
};

const withQuotedRfq = {
  ...EMPTY_SUPPLIER_API,
  'GET /rfqs': { rfqs: [ALREADY_QUOTED_RFQ], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
};

const field = (label) => screen.getByLabelText(label, { exact: false });

const openQuotationTab = async (user) => {
  const tab = (await screen.findAllByRole('button', { name: /^Submit Quotation$/i }))
    .find((button) => button.getAttribute('type') !== 'submit');
  await user.click(tab);
  await waitFor(() => expect(field('Unit price (₹)')).toBeInTheDocument(), { timeout: 4000 });
};

const renderRfqs = (api = withQuotedRfq) =>
  renderWithPortal(<RfqsPage />, { plane: 'supplier', route: '/rfqs', api });

describe('a supplier can see the price they already submitted', () => {
  it('shows the submitted quote in the RFQ Monitor detail view', async () => {
    renderRfqs();

    // RFQ Monitor & History is the default tab.
    await waitFor(() => expect(screen.getByText(/your quote/i)).toBeInTheDocument());
    expect(screen.getByText(/L10 ₹1000/)).toBeInTheDocument();
  });

  it('pre-fills the Submit Quotation form with the already-quoted price, not a blank form', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('alert', vi.fn());
    renderRfqs();

    await openQuotationTab(user);
    await user.selectOptions(screen.getByLabelText('Choose a request'), 'RFQ-2026-005');

    await waitFor(() => expect(field('Unit price (₹)')).toHaveValue(1000));
    expect(field('Delivery lead time (days)')).toHaveValue(7);
  });
});
