import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';

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

// Every supplier view names itself with a level-2 page title.
const ROUTES = [
  ['/', DashboardPage, 'Vendor Dashboard'],
  ['/rfqs', RfqsPage, 'RFQ Management'],
  ['/pos', PurchaseOrdersPage, /Purchase Orders/i],
  ['/invoices', InvoicesPage, /Invoice Submission/i],
  ['/payments', PaymentsPage, /Payment Tracking/i],
  ['/performance', PerformancePage, /Supplier Performance scorecard/i],
  ['/analytics', AnalyticsPage, /Reports & Analytics/i],
  ['/registration', RegistrationPage, /Vendor Registration/i],
];

describe.each(ROUTES)('%s', (route, Page, heading) => {
  it('names itself for a supplier with no documents', async () => {
    renderWithPortal(<Page />, { plane: 'supplier', route, api: EMPTY_SUPPLIER_API });

    expect(await screen.findByRole('heading', { name: heading, level: 2 })).toBeInTheDocument();
  });

  it('renders without the session redirecting away', async () => {
    const { navigation } = renderWithPortal(<Page />, {
      plane: 'supplier', route, api: EMPTY_SUPPLIER_API,
    });

    await screen.findByRole('heading', { name: heading, level: 2 });
    // PortalProvider bounces a tokenless visitor to /sign-in and anyone still
    // on a temporary password to /change-password. Neither applies here, and a
    // page that redirects anyway is a provider bug, not a page that "renders".
    await waitFor(() => expect(navigation.push).not.toHaveBeenCalled());
  });

  it('opens its heading outline at level 2, with no skipped level', async () => {
    renderWithPortal(<Page />, { plane: 'supplier', route, api: EMPTY_SUPPLIER_API });
    await screen.findByRole('heading', { name: heading, level: 2 });

    // /pos used to open on an <h4> naming its filter panel, because the list
    // view had no page title at all and the tab bar was standing in for one —
    // so a screen reader's heading list for the page read "Search & Filter".
    const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .map((node) => Number(node.tagName[1]));

    expect(levels[0]).toBe(2);
    // Descending into a subsection one level at a time; jumping h2 -> h4 makes
    // the outline claim a section that is not there.
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
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
