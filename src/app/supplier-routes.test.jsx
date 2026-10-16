import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import { expectHeadingOutline } from '@/test/outline';

import DashboardPage from '@/app/page';
import RfqsPage from '@/app/rfqs/page';
import PurchaseOrdersPage from '@/app/pos/page';
import InvoicesPage from '@/app/invoices/page';
import PaymentsPage from '@/app/payments/page';
import PerformancePage from '@/app/performance/page';
import AnalyticsPage from '@/app/analytics/page';
import RegistrationPage from '@/app/registration/page';
import AdminRedirectPage from '@/app/admin/page';

// The supplier portal's routes, each rendered inside the real
// ThemeProvider → ShellProvider → PortalProvider stack against a supplier who
// has an approved profile and no documents yet. The headings live in the
// feature views the thin page components delegate to.

// Every supplier view names itself with a level-1 page title (PageHeader).
// Titles follow the redesign's copy (docs/redesign/01-audit.md §4.3).
const ROUTES = [
  ['/', DashboardPage, 'Overview'],
  ['/rfqs', RfqsPage, 'RFQs'],
  ['/pos', PurchaseOrdersPage, 'Purchase orders'],
  ['/invoices', InvoicesPage, /^Invoices$/i],
  ['/payments', PaymentsPage, 'Payments'],
  ['/performance', PerformancePage, 'Performance'],
  ['/analytics', AnalyticsPage, 'Reports'],
  ['/registration', RegistrationPage, /Vendor Registration/i],
];

describe.each(ROUTES)('%s', (route, Page, heading) => {
  it('names itself for a supplier with no documents', async () => {
    renderWithPortal(<Page />, { plane: 'supplier', route, api: EMPTY_SUPPLIER_API });

    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
  });

  it('renders without the session redirecting away', async () => {
    const { navigation } = renderWithPortal(<Page />, {
      plane: 'supplier', route, api: EMPTY_SUPPLIER_API,
    });

    await screen.findByRole('heading', { name: heading, level: 1 });
    // PortalProvider bounces a tokenless visitor to /sign-in and anyone still
    // on a temporary password to /change-password. Neither applies here, and a
    // page that redirects anyway is a provider bug, not a page that "renders".
    await waitFor(() => expect(navigation.push).not.toHaveBeenCalled());
  });

  it('opens its heading outline at level 1, with no skipped level', async () => {
    renderWithPortal(<Page />, { plane: 'supplier', route, api: EMPTY_SUPPLIER_API });
    await screen.findByRole('heading', { name: heading, level: 1 });

    expectHeadingOutline(route);
  });
});

describe('/admin', () => {
  it('redirects to the workspace it became', async () => {
    const { navigation } = renderWithPortal(<AdminRedirectPage />, {
      plane: 'supplier', route: '/admin', api: EMPTY_SUPPLIER_API,
    });

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/workspace'));
  });
});
