import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';

import DashboardPage from '@/app/page';
import AnalyticsPage from '@/app/analytics/page';
import PerformancePage from '@/app/performance/page';

// A supplier with an approved profile and no documents, on the three screens
// that summarise their account. Each of these used to fill an empty account
// with figures of its own: a "Next Payment ₹8.4L scheduled for 15th Jun", a
// date frozen at 02 Jun 2025, "↑ 3 vs last week", a 94.8 performance score and
// grade A before any order existed, alerts for PO-2025-0071 and RFQ-2025-0041,
// and an analytics page of spend, vendor counts and ledger rows for a company
// called Shiva Enterprises. A supplier reads every one of those as a statement
// about their own account, so the rule pinned here is the simple one: nothing
// with no documents behind it.

const INVENTED = [
  /8\.4L/,
  /15th Jun/,
  /02 Jun 2025/,
  /vs last week/,
  /PO-2025-0071/,
  /RFQ-2025-0041/,
  /INV-2025-0084/,
  /94\.8/,
  /1,245,600/,
  /Shiva Enterprises/,
  /VND10023/,
];

const expectNothingInvented = () => {
  const text = document.body.textContent;
  INVENTED.forEach((pattern) => expect(text, `found ${pattern}`).not.toMatch(pattern));
};

describe('an account with no documents shows no invented figures', () => {
  it('on the dashboard', async () => {
    renderWithPortal(<DashboardPage />, { plane: 'supplier', route: '/', api: EMPTY_SUPPLIER_API });
    await screen.findByRole('heading', { name: 'Vendor Dashboard', level: 2 });
    // The KPI row renders after the dashboard's skeleton beat.
    await screen.findByText('Awaiting Payment', {}, { timeout: 3000 });

    expectNothingInvented();
    expect(screen.getByText('All Action Items Cleared')).toBeInTheDocument();
  });

  it('on reports & analytics', async () => {
    renderWithPortal(<AnalyticsPage />, { plane: 'supplier', route: '/analytics', api: EMPTY_SUPPLIER_API });
    await screen.findByRole('heading', { name: /Reports & Analytics/, level: 2 });

    expectNothingInvented();
    expect(screen.getByText('No purchase orders yet.')).toBeInTheDocument();
  });

  it('on the performance scorecard', async () => {
    renderWithPortal(<PerformancePage />, { plane: 'supplier', route: '/performance', api: EMPTY_SUPPLIER_API });
    await screen.findByRole('heading', { name: /Supplier Performance scorecard/i, level: 2 });

    expectNothingInvented();
  });
});
