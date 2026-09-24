import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import RfqsPage from '@/app/rfqs/page';

// A supplier pushed RFQ-2026-007's priced items (its own 3 lines) to SAP
// document 6000000072's number instead of 6000000074's — SAP accepted it
// anyway, and nothing in the portal showed the price anywhere, because the
// "Update Price (ME47)" modal let the target document (whichever "My
// Documents" row was clicked) and the RFQ sourcing the line items (a
// separate, unconstrained dropdown) disagree. Every RFQ now carries the real
// sapDocNumber the discovery sweep matched it to, so the modal restricts the
// RFQ choice to the one(s) actually matching the clicked document instead of
// trusting a human to pick correctly from every RFQ in the workspace.

const RFQ_A = {
  id: 'RFQ-2026-005', description: 'Flange order', status: 'Bidding Open', deadlineDate: null,
  currency: 'INR', rfqType: 'AN', createdDate: '2026-09-23T00:00:00.000Z', sapDocNumber: '6000000072',
  items: [{ line: 10, materialCode: 'MAT-0032', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, uom: 'KG', targetPrice: null }],
  invitedVendors: [{ id: 'VND-00001', name: 'Test Supplier Pvt Ltd', status: 'Pending', rating: null }],
  bids: [],
};

const RFQ_B = {
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

const SAP_DOC_A = { sapRfqNumber: '6000000072', date: '20260923', currency: 'INR', purchasingOrg: 'SSDN' };
const SAP_DOC_B = { sapRfqNumber: '6000000074', date: '20260923', currency: 'INR', purchasingOrg: 'SSDN' };

const withDocs = {
  ...EMPTY_SUPPLIER_API,
  'GET /rfqs': { rfqs: [RFQ_A, RFQ_B], pagination: { total: 2, page: 1, limit: 20, pages: 1 } },
  'GET /rfqs/sap-status': { documents: [SAP_DOC_A, SAP_DOC_B] },
  'GET /rfqs/sap-quotations': { documents: [] },
};

const openMyDocumentsTab = async (user) => {
  const tab = await screen.findByRole('button', { name: /my documents/i });
  await user.click(tab);
  await waitFor(() => expect(screen.getByText('6000000074')).toBeInTheDocument());
};

const renderRfqs = (api = withDocs) =>
  renderWithPortal(<RfqsPage />, { plane: 'supplier', route: '/rfqs', api });

describe('Update Price (ME47) — linking a SAP document to its own RFQ', () => {
  it('auto-selects the one RFQ matching the clicked document, with no picker to get wrong', async () => {
    const user = userEvent.setup();
    renderRfqs();
    await openMyDocumentsTab(user);

    const row = screen.getByText('6000000074').closest('tr');
    await user.click(within(row).getByRole('button', { name: /update price/i }));

    // The modal shows RFQ-2026-007's own three lines straight away — no
    // "-- Choose RFQ --" dropdown to independently (and wrongly) repoint at
    // a different RFQ, since only one RFQ matches this document.
    expect(await screen.findByText(/RFQ-2026-007/)).toBeInTheDocument();
    expect(screen.getByText('MAT-0032')).toBeInTheDocument();
    expect(screen.getByText('MAT-0033')).toBeInTheDocument();
    expect(screen.getByText('MAT-0034')).toBeInTheDocument();
    expect(screen.queryByLabelText('Linked RFQ')).not.toBeInTheDocument();
  });

  it('sends the clicked document\'s own RFQ items to the matching sapRfqNumber, never a different RFQ\'s', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderRfqs({
      ...withDocs,
      'POST /rfqs/RFQ-2026-007/sap-quote-price': { message: 'Quotation updated successfully', sapRfqNumber: '6000000074' },
    });
    await openMyDocumentsTab(user);

    const row = screen.getByText('6000000074').closest('tr');
    await user.click(within(row).getByRole('button', { name: /update price/i }));

    await screen.findByText(/RFQ-2026-007/);
    const priceInputs = screen.getAllByRole('spinbutton');
    await user.type(priceInputs[0], '1000');
    await user.type(priceInputs[1], '150');
    await user.type(priceInputs[2], '10');

    await user.click(screen.getByRole('button', { name: /send to sap/i }));

    await waitFor(() =>
      expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-007/sap-quote-price')).toHaveLength(1));

    const body = apiMock.lastBody('POST', '/rfqs/RFQ-2026-007/sap-quote-price');
    // The regression: this used to be able to carry 6000000072 (the other
    // document) while items still came from RFQ-2026-007.
    expect(body.sapRfqNumber).toBe('6000000074');
    expect(body.items.map((i) => i.line).sort()).toEqual([10, 20, 30]);

    // No cross-request to price the other RFQ's document.
    expect(apiMock.callsTo('POST', '/rfqs/RFQ-2026-005/sap-quote-price')).toHaveLength(0);
  });

  it('refuses to offer any RFQ when no portal RFQ is matched to the document', async () => {
    const user = userEvent.setup();
    renderRfqs({
      ...withDocs,
      'GET /rfqs': { rfqs: [RFQ_A], pagination: { total: 1, page: 1, limit: 20, pages: 1 } }, // RFQ-2026-007 missing
    });
    await openMyDocumentsTab(user);

    const row = screen.getByText('6000000074').closest('tr');
    await user.click(within(row).getByRole('button', { name: /update price/i }));

    expect(await screen.findByText(/no rfq in this workspace is matched/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send to sap/i })).toBeDisabled();
  });
});
