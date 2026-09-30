import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import RfqsPage from '@/app/rfqs/page';

// A sealed tender does not name the competition, so the API no longer sends a
// supplier the invitee list. The request detail must render without it, not
// show an empty "Invited vendors" section.

const OPEN_RFQ = {
  id: 'RFQ-2026-007', description: 'Fasteners', status: 'Bidding Open', deadlineDate: null,
  currency: 'INR', rfqType: 'AN', createdDate: '2026-09-23T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-0032', description: 'Hex bolts', quantity: 10, uom: 'KG', targetPrice: null }],
  bids: [],
};

const renderWith = (rfq) => renderWithPortal(<RfqsPage />, {
  plane: 'supplier',
  route: '/rfqs',
  api: { ...EMPTY_SUPPLIER_API, 'GET /rfqs': { rfqs: [rfq], pagination: { total: 1, page: 1, limit: 20, pages: 1 } } },
});

describe('the supplier RFQ detail with no invitee list', () => {
  it('shows the request without an "Invited vendors" section', async () => {
    renderWith(OPEN_RFQ);

    expect(await screen.findByText(/Progress of this request/i)).toBeInTheDocument();
    expect(screen.queryByText(/Invited vendors/i)).not.toBeInTheDocument();
  });

  it('still shows the section when the API supplies one (staff-shaped payload)', async () => {
    renderWith({ ...OPEN_RFQ, invitedVendors: [{ id: 'VND-00002', name: 'Beta Supplies', status: 'Pending', rating: 88 }] });

    expect(await screen.findByText(/Invited vendors/i)).toBeInTheDocument();
  });
});
