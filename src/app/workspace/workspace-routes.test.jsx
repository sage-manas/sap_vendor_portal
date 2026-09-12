import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';

import WorkspaceOverviewPage from '@/app/workspace/page';
import WorkspaceRfqsPage from '@/app/workspace/rfqs/page';
import WorkspaceSuppliersPage from '@/app/workspace/suppliers/page';
import WorkspaceUsersPage from '@/app/workspace/users/page';
import WorkspaceAuditPage from '@/app/workspace/audit/page';
import WorkspaceSettingsPage from '@/app/workspace/settings/page';
import WorkspaceInvoicesPage from '@/app/workspace/invoices/page';
import WorkspacePaymentsPage from '@/app/workspace/payments/page';
import WorkspacePurchaseOrdersPage from '@/app/workspace/purchase-orders/page';

// Every route in the tenant back office renders, names itself, and says so
// honestly when it has no data. Cheap, and it catches the things that are
// otherwise only found by opening the page: an import cycle, a provider the
// route is not actually inside of, and — the common one — a page reading
// `data.some.field` the API does not return, which throws on an empty tenant.

const ROUTES = [
  ['/workspace', WorkspaceOverviewPage, 'Nucleus Manufacturing'],
  ['/workspace/rfqs', WorkspaceRfqsPage, 'RFQs'],
  ['/workspace/suppliers', WorkspaceSuppliersPage, 'Suppliers'],
  ['/workspace/users', WorkspaceUsersPage, 'Users'],
  ['/workspace/audit', WorkspaceAuditPage, 'Audit'],
  ['/workspace/settings', WorkspaceSettingsPage, 'Settings'],
  ['/workspace/invoices', WorkspaceInvoicesPage, 'Invoices'],
  ['/workspace/payments', WorkspacePaymentsPage, 'Payments'],
  ['/workspace/purchase-orders', WorkspacePurchaseOrdersPage, 'Purchase Orders'],
];

const settle = () => waitFor(() => {
  expect(document.body.textContent).not.toMatch(/^\s*$/);
  expect(screen.queryByText(/^Loading/i)).not.toBeInTheDocument();
});

describe.each(ROUTES)('%s', (route, Page, heading) => {
  it('renders its heading against an empty tenant', async () => {
    renderWithPortal(<Page />, { plane: 'workspace', route, api: EMPTY_WORKSPACE_API });

    await settle();
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
  });

  it('asks only for endpoints the fixtures know about', async () => {
    const { apiMock } = renderWithPortal(<Page />, {
      plane: 'workspace', route, api: EMPTY_WORKSPACE_API,
    });

    await settle();
    // An unmatched route means the page fetched something this fixture set does
    // not describe — either a new endpoint, or a typo'd one that would 404 in
    // the app too. Both are worth failing on.
    expect(apiMock.unmatched).toEqual([]);
  });
});
