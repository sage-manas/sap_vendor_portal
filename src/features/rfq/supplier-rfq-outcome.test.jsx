import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, VENDOR_PROFILE } from '@/test/fixtures';
import RfqsPage from '@/app/rfqs/page';

// Issue #287: the supplier's RFQ detail described the whole tender while
// holding only this supplier's own slice of it.
//
// The sealed-tender rule (rfqIncludeFor in backend/controllers/rfq.controller.js)
// returns a supplier exactly one bid — theirs — so "N bid(s) received" read
// "1 bid(s) received" on a tender with twenty quotes in it, "Evaluation:
// Review ready" claimed to know the buyer's queue, and "Order raised /
// Conversion completed" fired off `status === 'Awarded'` whoever had won and
// whether or not a purchase order existed. Each fixture below is one of those
// states, asserted from what the API actually hands a supplier.

const OWN_BID = {
  vendorId: 'VND-00001',
  vendorName: 'Test Supplier Pvt Ltd',
  unitPrices: { 10: 1000 },
  gstRate: '18%',
  freight: 0,
  deliveryLeadTimeDays: 7,
  validityDate: '2026-10-24T00:00:00.000Z',
  remarks: 'Quote Ref: N/A | Discount: 0% | Incoterms: EXW',
  submittedAt: '2026-09-24T11:31:29.316Z',
};

const BASE_RFQ = {
  id: 'RFQ-2026-005',
  description: 'Flange order',
  status: 'Bidding Open',
  deadlineDate: '2026-09-30T00:00:00.000Z',
  currency: 'INR',
  rfqType: 'AN',
  createdDate: '2026-09-23T00:00:00.000Z',
  sapDocNumber: '6000000072',
  items: [{ line: 10, materialCode: 'MAT-0032', description: 'Flange 80NB', quantity: 10, uom: 'KG', targetPrice: null }],
  // A supplier's payload carries no invitee list (rfq-sealed-invitees.test.js)
  // and only their own bid.
  bids: [OWN_BID],
};

const apiWith = (rfq, profile = VENDOR_PROFILE) => ({
  ...EMPTY_SUPPLIER_API,
  'GET /vendors/profile': profile,
  'GET /rfqs': { rfqs: [rfq], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
});

const renderRfqs = (api) => renderWithPortal(<RfqsPage />, { plane: 'supplier', route: '/rfqs', api });

// A quoted request is not in "Awaiting your quotation"; its outcome is read
// under "Quoted by you".
const showQuoted = async (user) => {
  const scope = await screen.findByLabelText('Show', {}, { timeout: 4000 });
  await user.selectOptions(scope, 'quoted');
  return screen.findByRole('heading', { name: /Progress of this request/i }, { timeout: 4000 });
};

describe('a supplier is shown only what they know about their own quotation', () => {
  it('reports their own quotation instead of counting the bids they can see', async () => {
    const user = userEvent.setup();
    renderRfqs(apiWith(BASE_RFQ));
    await showQuoted(user);

    // The sealed-tender count is gone — and so is the static "Score weights
    // active", which was never sourced from anything.
    expect(screen.queryByText(/bid\(s\) received/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/score weights/i)).not.toBeInTheDocument();

    expect(screen.getByText('Your quotation')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText(/Submitted 24\.09\.2026/)).toBeInTheDocument();
    // The buyer's side is described as unknown, not as "review ready".
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText(/order raised/i)).not.toBeInTheDocument();
  });

  it('names the order only once one is actually linked to the award', async () => {
    const user = userEvent.setup();
    renderRfqs(apiWith({
      ...BASE_RFQ,
      status: 'Awarded',
      awardedVendorId: 'VND-00001',
      awardedVendorName: 'Test Supplier Pvt Ltd',
      awardedAt: '2026-10-01T00:00:00.000Z',
      convertedPoId: 'PO-2026-0001',
    }));
    await showQuoted(user);

    // Twice over: the Outcome step and the footer badge.
    expect(screen.getAllByText('Awarded to you')).toHaveLength(2);
    expect(screen.getByText('Order raised: PO-2026-0001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export order/i })).toBeInTheDocument();
  });

  it('says the order is pending when the award produced no purchase order', async () => {
    const user = userEvent.setup();
    renderRfqs(apiWith({
      ...BASE_RFQ,
      status: 'Awarded',
      awardedVendorId: 'VND-00001',
      awardedVendorName: 'Test Supplier Pvt Ltd',
      awardedAt: '2026-10-01T00:00:00.000Z',
      convertedPoId: null,
    }));
    await showQuoted(user);

    expect(screen.getAllByText('Awarded to you')).toHaveLength(2);
    expect(screen.getByText('Order pending')).toBeInTheDocument();
    // Nothing to export: exportAwardedPo refuses an RFQ with no converted PO.
    expect(screen.queryByRole('button', { name: /Export order/i })).not.toBeInTheDocument();
  });

  it('tells a losing supplier their quotation was not accepted, and nothing else', async () => {
    const user = userEvent.setup();
    // The award fields are absent because formatRfqFor strips them for a
    // supplier who did not win — this fixture is the payload that supplier
    // actually receives, not an edited version of the winner's.
    renderRfqs(apiWith({ ...BASE_RFQ, status: 'Awarded' }));
    await showQuoted(user);

    expect(screen.getByText('Your quotation was not accepted')).toBeInTheDocument();
    expect(screen.getByText('This request is now closed')).toBeInTheDocument();

    // No winner, no winning price, no order, no export.
    expect(screen.queryByText(/awarded to/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Beta Supplies/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/order raised/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export order/i })).not.toBeInTheDocument();
  });

  it('shows an em dash, not a fabricated code, when SAP has issued none', async () => {
    const user = userEvent.setup();
    renderRfqs(apiWith(BASE_RFQ, { ...VENDOR_PROFILE, sapVendorCode: null }));

    const tab = await screen.findByRole('tab', { name: /^My documents$/i }, { timeout: 4000 });
    await user.click(tab);

    await waitFor(() => expect(screen.getByText(/supplier ID/i)).toBeInTheDocument());
    // 'VND-CURRENT' was the placeholder this screen rendered as though SAP had
    // issued it.
    expect(screen.queryByText(/VND-CURRENT/)).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/assigned after approval/i)).toBeInTheDocument();
  });
});
