import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import PurchaseOrdersPage from '@/app/pos/page';

// Issue #351. A buyer's SAP connection with no acknowledgement field records
// nothing in SAP; the server now says so (sapWritten: false) instead of
// logging an SAP call that never happened. The supplier must hear it too —
// otherwise "Acknowledged" reads as the buyer's system knowing.

const po = (overrides) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Open',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150 }],
  ...overrides,
});

const acknowledge = async (sapWritten) => {
  const user = userEvent.setup();
  const { apiMock } = renderWithPortal(<PurchaseOrdersPage />, {
    plane: 'supplier',
    route: '/pos',
    api: {
      ...EMPTY_SUPPLIER_API,
      'GET /pos': { pos: [po()], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      'PUT /pos/PO-2026-0001/acknowledge': { message: 'ok', sapWritten, po: po({ status: 'Acknowledged' }) },
    },
  });

  await user.click(await screen.findByRole('button', { name: 'Open PO-2026-0001' }));
  await user.click(await screen.findByRole('button', { name: 'Acknowledge purchase order' }));
  await waitFor(() => expect(apiMock.callsTo('PUT', '/pos/PO-2026-0001/acknowledge')).toHaveLength(1));
};

describe('acknowledging a purchase order', () => {
  it('says the buyer\'s SAP system was not updated when SAP had nowhere to record it', async () => {
    await acknowledge(false);

    expect(await screen.findByText(/Your buyer's SAP system was not updated/i)).toBeInTheDocument();
  });

  it('does not say so when SAP recorded it', async () => {
    await acknowledge(true);

    expect(screen.queryByText(/SAP system was not updated/i)).not.toBeInTheDocument();
  });
});
