import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API, listOf } from '@/test/fixtures';

import WorkspaceRfqsPage from '@/app/workspace/rfqs/page';

// Issue #166. RFQ.deadlineDate is stored as a date, not a moment — always UTC
// midnight (see the schema comment on RFQ.deadlineDate) — but the Deadline
// column ran it through primitives.js's formatDate, a time-aware formatter.
// 00:00 UTC in IST (UTC+5:30) is 5:30 am, so every row showed the identical,
// meaningless "5:30 am" regardless of which day the deadline actually fell on.

const RFQ = {
  id: 'RFQ-2026-001',
  description: 'Bearings',
  status: 'Bidding Open',
  invitedVendors: [],
  bids: [],
  deadlineDate: '2026-09-19T00:00:00.000Z',
};

describe('/workspace/rfqs, the Deadline column', () => {
  it('shows the date without a spurious time-of-day', async () => {
    renderWithPortal(<WorkspaceRfqsPage />, {
      plane: 'workspace',
      route: '/workspace/rfqs',
      api: { ...EMPTY_WORKSPACE_API, 'GET /rfqs': listOf('rfqs', [RFQ]) },
    });

    await screen.findByText('RFQ-2026-001');
    expect(screen.getByText(/19 Sept 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/5:30/)).not.toBeInTheDocument();
    expect(screen.queryByText(/am|pm/i)).not.toBeInTheDocument();
  });
});
