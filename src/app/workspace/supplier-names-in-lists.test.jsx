import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspacePurchaseOrdersPage from '@/app/workspace/purchase-orders/page';
import WorkspaceInvoicesPage from '@/app/workspace/invoices/page';

// Finding 4.3. Both tenant-wide lists rendered `vendorId` under a column
// headed "Supplier" — the portal's own internal key (ADR-0002), not the SAP
// vendor code and not a name anyone in the buying organisation recognises.
// Staff were reading a list of other companies' orders identified by a string
// they could only resolve by opening each row.
//
// The name now comes from the API (`vendorName`, one batched lookup per page —
// see backend/utils/vendorNames.js). These assert the rendering half: the
// company is what the column shows, the code stays reachable because it is
// what SAP and the detail route key on, and an order whose supplier this
// tenant does not hold still shows the code rather than a blank cell.

const PO = {
  id: 'PO-2026-0001',
  sapPoNumber: null,
  vendorId: 'vendor_test_001',
  vendorName: 'Acme Industries Pvt Ltd',
  currency: 'INR',
  status: 'Open',
  createdDate: '2026-02-01T00:00:00.000Z',
  items: [{ line: 10, netValue: 1150 }],
};

const INVOICE = {
  id: 'INV-0001',
  invoiceNumber: 'ACME/2026/01',
  vendorId: 'vendor_test_001',
  vendorName: 'Acme Industries Pvt Ltd',
  poId: 'PO-2026-0001',
  totalAmount: 1357,
  currency: 'INR',
  status: 'Submitted',
  invoiceDate: '2026-02-02T00:00:00.000Z',
};

const withPos = (...pos) => ({
  ...EMPTY_WORKSPACE_API,
  'GET /auth/me': TENANT_SESSION,
  'GET /pos': { pos, pagination: { total: pos.length, page: 1, limit: 200, pages: 1 } },
});

const withInvoices = (...invoices) => ({
  ...EMPTY_WORKSPACE_API,
  'GET /auth/me': TENANT_SESSION,
  'GET /invoices': { invoices, pagination: { total: invoices.length, page: 1, limit: 200, pages: 1 } },
});

const renderPos = (api) => renderWithPortal(<WorkspacePurchaseOrdersPage />, {
  plane: 'workspace', route: '/workspace/purchase-orders', api,
});

const renderInvoices = (api) => renderWithPortal(<WorkspaceInvoicesPage />, {
  plane: 'workspace', route: '/workspace/invoices', api,
});

describe('the workspace purchase-order list identifies the supplier by name', () => {
  it('shows the company name, not only the vendor code', async () => {
    renderPos(withPos(PO));

    expect(await screen.findByText('Acme Industries Pvt Ltd')).toBeInTheDocument();
    // The code is still there to reconcile against SAP with — this adds a
    // field rather than hiding one.
    expect(screen.getByText('vendor_test_001')).toBeInTheDocument();
  });

  it('falls back to the vendor code for an order whose supplier this tenant does not hold', async () => {
    // sweepPurchaseOrders writes an order SAP reported for a LIFNR that was
    // never onboarded here; the API answers vendorName: null for it rather
    // than inventing a company.
    renderPos(withPos({ ...PO, id: 'PO-2026-0002', vendorId: 'LIFNR-77001', vendorName: null }));

    expect(await screen.findByText('LIFNR-77001')).toBeInTheDocument();
  });

  it('distinguishes two suppliers in the same list', async () => {
    renderPos(withPos(
      PO,
      { ...PO, id: 'PO-2026-0003', vendorId: 'vendor_test_002', vendorName: 'Beta Supplies Pvt Ltd' },
    ));

    expect(await screen.findByText('Acme Industries Pvt Ltd')).toBeInTheDocument();
    expect(screen.getByText('Beta Supplies Pvt Ltd')).toBeInTheDocument();
  });
});

describe('the workspace invoice list identifies the supplier by name', () => {
  it('shows the company name, not only the vendor code', async () => {
    renderInvoices(withInvoices(INVOICE));

    expect(await screen.findByText('Acme Industries Pvt Ltd')).toBeInTheDocument();
    expect(screen.getByText('vendor_test_001')).toBeInTheDocument();
  });

  it('falls back to the vendor code when the API has no name for it', async () => {
    renderInvoices(withInvoices({ ...INVOICE, vendorId: 'LIFNR-77001', vendorName: null }));

    expect(await screen.findByText('LIFNR-77001')).toBeInTheDocument();
  });

  // The row still has to link to the supplier it belongs to, which keys on
  // the code — the thing the display change must not have broken.
  it('still routes a row through to its supplier', async () => {
    const { navigation } = renderInvoices(withInvoices(INVOICE));

    const cell = await screen.findByText('Acme Industries Pvt Ltd');
    await userEvent.click(cell.closest('tr'));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/workspace/suppliers/vendor_test_001'));
  });
});
