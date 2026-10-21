import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API, WORKSPACE_OVERVIEW } from '@/test/fixtures';

import WorkspaceOverviewPage from '@/app/workspace/page';

// Issue #283. The Finance tile's hint used to be the face value of every
// invoice that was not Cleared, which overstated it twice over: a Rejected
// invoice is not money the buyer owes, and a part-paid invoice owes only its
// balance. Both are now the server's business (the overview endpoint applies
// INVOICE_OPEN and nets off every PaymentItem), so what this test holds the
// screen to is that it renders *that* figure, under a label saying which
// figure it is — a bare amount beside a count is exactly how the overstated
// number went unnoticed.
//
// The two amounts here deliberately differ: ₹1,50,000 still owed across
// invoices raised for ₹2,00,000. A screen that printed the face value as the
// outstanding total would read "₹2,00,000 still owed" and fail.

const api = {
  ...EMPTY_WORKSPACE_API,
  'GET /workspace/overview': {
    ...WORKSPACE_OVERVIEW,
    finance: {
      ...WORKSPACE_OVERVIEW.finance,
      invoicesTotal: 4,
      invoicesOpen: 2,
      invoicesOpenValue: 150000,
      invoicesOpenFaceValue: 200000,
    },
  },
};

describe('the workspace overview says what is still owed, not what was invoiced', () => {
  it('names both amounts on the open-invoices tile', async () => {
    renderWithPortal(<WorkspaceOverviewPage />, { plane: 'workspace', route: '/workspace', api });

    await screen.findByRole('heading', { name: 'Finance' });

    expect(screen.getByText('Invoices not yet cleared')).toBeInTheDocument();
    const hint = screen.getByText(/still owed/);
    expect(hint.textContent).toMatch(/1,50,000\.00 still owed/);
    expect(hint.textContent).toMatch(/2,00,000\.00 invoiced/);
  });

  it('does not report the face value as the outstanding amount', async () => {
    renderWithPortal(<WorkspaceOverviewPage />, { plane: 'workspace', route: '/workspace', api });

    await screen.findByRole('heading', { name: 'Finance' });

    expect(screen.getByText(/still owed/).textContent).not.toMatch(/2,00,000 still owed/);
  });
});
