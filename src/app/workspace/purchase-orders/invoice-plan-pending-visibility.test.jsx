import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspacePurchaseOrdersPage from '@/app/workspace/purchase-orders/page';

// PO-2026-0077's proposed invoice-plan change was saved correctly all along,
// and the approve/reject controls already existed on the order's own detail
// page — but nothing on THIS list, the one a client_admin actually lands on,
// said a proposal was waiting. They had no way to know without already
// knowing which order to open. This is the client_admin-facing workspace
// list (a different, simpler component from the supplier-facing
// PurchaseOrdersView — the two must not be confused).

const poWithPendingChange = {
  id: 'PO-2026-0077', sapPoNumber: '4500022837', vendorId: 'VND-20617', status: 'Delivered', currency: 'INR',
  createdDate: '2026-09-23T00:00:00.000Z',
  items: [{
    line: 10, materialCode: '', description: 'TESTING', quantity: 10, netValue: 100000, uom: 'LE',
    invoicePlan: {
      enabled: true, planNumber: '0000001267',
      pendingChange: { input: { type: 'Partial', milestones: [] }, requestedAt: '2026-09-24T12:22:33.708Z', requestedBy: 'VND-20617' },
    },
  }],
};

const poWithoutPendingChange = {
  id: 'PO-2026-0072', sapPoNumber: '6000000072', vendorId: 'VND-20617', status: 'Open', currency: 'INR',
  createdDate: '2026-09-23T00:00:00.000Z',
  items: [{ line: 10, materialCode: '', description: 'NEW MATERIAL SAGE TESTING', quantity: 10, netValue: 0, uom: 'KG' }],
};

const sessionWith = (permission) => ({
  ...TENANT_SESSION,
  auth: { ...TENANT_SESSION.auth, permissions: [...TENANT_SESSION.auth.permissions, permission] },
});
const sessionWithout = (permission) => ({
  ...TENANT_SESSION,
  auth: { ...TENANT_SESSION.auth, permissions: TENANT_SESSION.auth.permissions.filter((p) => p !== permission) },
});

const apiWith = (session) => ({
  ...EMPTY_WORKSPACE_API,
  'GET /auth/me': session,
  'GET /pos': { pos: [poWithPendingChange, poWithoutPendingChange], pagination: { total: 2, page: 1, limit: 200, pages: 1 } },
});

describe('client_admin sees a pending invoice-plan proposal on the PO list itself', () => {
  it('flags the order carrying a proposal, not the one without one', async () => {
    renderWithPortal(<WorkspacePurchaseOrdersPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders',
      api: apiWith(sessionWith('po:manage')),
    });

    const row = (await screen.findByText('4500022837')).closest('tr');
    expect(row).toHaveTextContent('Change Pending');

    const otherRow = screen.getByText('6000000072').closest('tr');
    expect(otherRow).not.toHaveTextContent('Change Pending');
  });

  it('does not show the column at all to a role without po:manage', async () => {
    renderWithPortal(<WorkspacePurchaseOrdersPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders',
      api: apiWith(sessionWithout('po:manage')),
    });

    await waitFor(() => expect(screen.getByText('4500022837')).toBeInTheDocument());
    expect(screen.queryByText('Change Pending')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /invoice plan/i })).not.toBeInTheDocument();
  });
});
