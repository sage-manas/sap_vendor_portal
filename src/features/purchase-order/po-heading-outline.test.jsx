import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, listOf } from '@/test/fixtures';
import { expectHeadingOutline } from '@/test/outline';
import PurchaseOrdersPage from '@/app/pos/page';

// Heading outlines for the purchase-order screens beyond the ledger list,
// which supplier-routes.test.jsx covers. Which sections render depends on the
// order's state, so each case puts an order in the state that shows the part
// under test.

const po = (overrides) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Open',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  sapSyncState: 'synced',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150 }],
  ...overrides,
});

const GRN = {
  id: 'GRN-000001',
  poId: 'PO-2026-0001',
  vendorId: 'VND-00001',
  sapMigoDoc: '5000012345',
  postingDate: '2026-02-01T00:00:00.000Z',
  receivedBy: 'Stores',
  invoiceSubmitted: false,
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', receivedQuantity: 100, acceptedQuantity: 95, rejectedQuantity: 5, uom: 'EA' }],
};

const TABS = ['1. Order details', '2. Delivery status'];

const renderLedger = (order, api = {}) => {
  const user = userEvent.setup();
  const { apiMock } = renderWithPortal(<PurchaseOrdersPage />, {
    plane: 'supplier',
    route: '/pos',
    api: { ...EMPTY_SUPPLIER_API, 'GET /pos': listOf('pos', [order]), ...api },
  });
  return { user, apiMock };
};

const withGrn = { 'GET /grns': listOf('grns', [GRN]) };

describe('the purchase-order detail view', () => {
  const openDetail = async (order, api) => {
    const { user } = renderLedger(order, api);
    await user.click(await screen.findByRole('button', { name: 'View PO' }, { timeout: 4000 }));
    await screen.findByRole('heading', { level: 2, name: /Purchase Order: PO-2026-0001/ });
    return user;
  };

  const walkTabs = async (user) => {
    for (const tab of TABS) {
      await user.click(screen.getByRole('button', { name: tab }));
      await waitFor(() => expectHeadingOutline(`the "${tab}" tab`));
    }
  };

  it('has no skipped level on any tab for an order awaiting acknowledgement', async () => {
    await walkTabs(await openDetail(po({ status: 'Open' })));
  });

  it('has no skipped level once the shipment has gone out', async () => {
    await walkTabs(await openDetail(po({ status: 'Dispatched' })));
  });

  it('nests the inspection result one level under the delivery receipt', async () => {
    const user = await openDetail(po({ status: 'Delivered' }), withGrn);
    await user.click(screen.getByRole('button', { name: '2. Delivery status' }));

    expect(await screen.findByRole('heading', { level: 3, name: 'Delivery receipt' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: /Items received/i })).toBeInTheDocument();
    await walkTabs(user);
  });

  it('keeps status messages out of the outline', async () => {
    const user = await openDetail(po({ status: 'Open' }));

    // A call to action or an empty state may look like a heading; being one
    // puts it in a screen reader's heading list as a section to read.
    await user.click(screen.getByRole('button', { name: '2. Delivery status' }));
    expect(await screen.findByText('No delivery confirmed yet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No delivery confirmed yet' })).not.toBeInTheDocument();
  });
});
