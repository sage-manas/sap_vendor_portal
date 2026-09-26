import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, routeParams } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API, VENDOR_PROFILE } from '@/test/fixtures';
import SupplierDetailPage from '@/app/workspace/suppliers/[id]/page';

const detail = (pendingBankChange) => ({
  vendor: { ...VENDOR_PROFILE, pk: 'vendor-pk-1', sapVendorCode: '1120250081', pendingBankChange },
  awaitingDecision: false,
  activity: {
    purchaseOrders: { total: 0, value: 0, byStatus: {} },
    invoices: { total: 0, value: 0, byStatus: {} },
    payments: { total: 0, grossPaid: 0, netPaid: 0, tdsDeducted: 0 },
    rfqInvitations: 0,
    goodsReceipts: 0,
    shipments: 0,
  },
  recentOrders: [],
});

const REQUEST = { bankName: 'HDFC Bank', accountNumber: '99999999999', ifscCode: 'HDFC0000999', requestedAt: '2026-09-20T10:00:00.000Z' };

const renderPage = (pendingBankChange, extraApi = {}) => renderWithPortal(
  <SupplierDetailPage params={routeParams({ id: 'vendor-pk-1' })} />,
  {
    plane: 'workspace',
    route: '/workspace/suppliers/vendor-pk-1',
    api: { ...EMPTY_WORKSPACE_API, 'GET /vendors/vendor-pk-1': detail(pendingBankChange), ...extraApi },
  },
);

describe('supplier bank-account change review', () => {
  it('lets an approver approve a requested change', async () => {
    const { apiMock } = renderPage(REQUEST, {
      'PUT /vendors/vendor-pk-1/bank-change/approve': { message: 'Approved.', awaitingSapConfirmation: true },
    });

    expect(await screen.findByText('Bank change requested by the supplier')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve change' }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/vendors/vendor-pk-1/bank-change/approve')).toHaveLength(1));
  });

  it('asks for SAP confirmation, not approval, once a change is approved but not yet in SAP', async () => {
    const { apiMock } = renderPage(
      { ...REQUEST, sapApproval: { approvedAt: '2026-09-21T10:00:00.000Z', approvedBy: 'admin@example.com' } },
      { 'PUT /vendors/vendor-pk-1/bank-change/confirm-sap': { message: 'Confirmed.' } },
    );

    expect(await screen.findByText(/waiting to be updated in SAP/)).toBeInTheDocument();
    expect(screen.getByText(/XK02/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve change' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm updated in SAP' }));
    await waitFor(() => expect(apiMock.callsTo('PUT', '/vendors/vendor-pk-1/bank-change/confirm-sap')).toHaveLength(1));
  });

  it('shows nothing when there is no pending change', async () => {
    renderPage(null);
    expect(await screen.findByRole('heading', { name: 'Banking' })).toBeInTheDocument();
    expect(screen.queryByText(/Bank change/)).not.toBeInTheDocument();
  });
});
