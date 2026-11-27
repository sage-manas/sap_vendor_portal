import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, listOf } from '@/test/fixtures';
import PurchaseOrdersPage from '@/app/pos/page';

// Issue #351. SAP's goods-receipt read carries no inspection result, so a
// receipt recorded from it has acceptedQuantity/rejectedQuantity null. It
// used to be written as fully accepted and badged "QC Passed" — a quality
// result nobody produced.

const po = (overrides) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Delivered',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  sapSyncState: 'synced',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 5, uom: 'EA', unitPrice: 10000, netValue: 50000 }],
  ...overrides,
});

const grn = (item) => ({
  id: 'GRN-2026-4900004426',
  poId: 'PO-2026-0001',
  vendorId: 'VND-00001',
  sapMigoDoc: '4900004426',
  postingDate: '2026-09-21T00:00:00.000Z',
  receivedBy: 'SAP',
  invoiceSubmitted: false,
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', receivedQuantity: 5, uom: 'EA', ...item }],
});

const openReceipt = async (item) => {
  const user = userEvent.setup();
  renderWithPortal(<PurchaseOrdersPage />, {
    plane: 'supplier',
    route: '/pos',
    api: { ...EMPTY_SUPPLIER_API, 'GET /pos': listOf('pos', [po()]), 'GET /grns': listOf('grns', [grn(item)]) },
  });
  await user.click(await screen.findByRole('button', { name: /^Open PO-/ }, { timeout: 4000 }));
  await user.click(await screen.findByRole('tab', { name: 'Delivery status' }));
  await screen.findByRole('heading', { level: 3, name: /Items received/i });
};

describe('a goods receipt nobody inspected', () => {
  it('says it was not inspected, and claims no QC result', async () => {
    await openReceipt({ acceptedQuantity: null, rejectedQuantity: null });

    const row = screen.getAllByText('Hex bolts').map((cell) => cell.closest('tr')).find(Boolean);
    expect(within(row).getByText('Not inspected')).toBeInTheDocument();
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText('QC Passed')).not.toBeInTheDocument();
    expect(screen.queryByText(/accepted by your buyer/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No inspection result has been reported/i)).toBeInTheDocument();
  });
});

describe('a goods receipt that was inspected', () => {
  it('still shows its result', async () => {
    await openReceipt({ acceptedQuantity: 4, rejectedQuantity: 1 });

    // In the receipt summary and on the line.
    expect(screen.getAllByText('QC Discrepancy')).toHaveLength(2);
    expect(screen.queryByText('Not inspected')).not.toBeInTheDocument();
  });
});
