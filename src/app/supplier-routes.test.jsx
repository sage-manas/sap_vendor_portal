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

// `heading` is asserted as a level-2 page title where the view has one. The
// purchase-order ledger is the exception: in list view it titles itself with a
// tab bar rather than a heading (the only <h2> on it belongs to the filter
// panel), so it is matched on the empty state it is actually supposed to show.
const ROUTES = [
  ['/', DashboardPage, { heading: 'Vendor Dashboard' }],
  ['/rfqs', RfqsPage, { heading: 'RFQ Management' }],
  ['/pos', PurchaseOrdersPage, { text: /No Purchase Orders Found/i }],
  ['/invoices', InvoicesPage, { heading: /Invoice Submission/i }],
  ['/payments', PaymentsPage, { heading: /Payment Tracking/i }],
  ['/performance', PerformancePage, { heading: /Supplier Performance scorecard/i }],
  ['/analytics', AnalyticsPage, { heading: /Reports & Analytics/i }],
  ['/registration', RegistrationPage, { heading: /Vendor Registration/i }],
];

const findLandmark = ({ heading, text }) =>
  (heading ? screen.findByRole('heading', { name: heading }) : screen.findByText(text));

describe.each(ROUTES)('%s', (route, Page, landmark) => {
  it('names itself for a supplier with no documents', async () => {
    renderWithPortal(<Page />, { plane: 'supplier', route, api: EMPTY_SUPPLIER_API });

    expect(await findLandmark(landmark)).toBeInTheDocument();
  });

  it('renders without the session redirecting away', async () => {
    const { navigation } = renderWithPortal(<Page />, {
      plane: 'supplier', route, api: EMPTY_SUPPLIER_API,
    });

    await findLandmark(landmark);
    // PortalProvider bounces a tokenless visitor to /sign-in and anyone still
    // on a temporary password to /change-password. Neither applies here, and a
    // page that redirects anyway is a provider bug, not a page that "renders".
    await waitFor(() => expect(navigation.push).not.toHaveBeenCalled());
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
