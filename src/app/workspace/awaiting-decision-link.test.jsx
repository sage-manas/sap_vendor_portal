import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API, WORKSPACE_OVERVIEW, listOf } from '@/test/fixtures';

import WorkspacePage from '@/app/workspace/page';
import SuppliersPage from '@/app/workspace/suppliers/page';

// Issue #289. "Awaiting a decision" counts Under Review *and* Pending
// Approval, but its link said `?status=Under+Review` — one of the two. A
// number that opens a shorter list than itself teaches staff to distrust both.
//
// The count's agreement with the list is asserted against the real API in
// backend/tests/vendor-status-group-filter.test.js. These two are the halves
// that live in the browser: the tile links to the group, and the directory
// asks the API for the group rather than quietly narrowing it.

const vendorRow = (vendorId, status) => ({
  pk: `pk-${vendorId}`,
  vendorId,
  companyName: `${vendorId} Pvt Ltd`,
  email: `${vendorId}@example.com`,
  status,
  gstin: '27AAAAA0000A1Z1',
});

describe('the workspace "Awaiting a decision" tile', () => {
  it('links to the whole group it counted, not one status of it', async () => {
    renderWithPortal(<WorkspacePage />, {
      plane: 'workspace',
      route: '/workspace',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /workspace/overview': {
          ...WORKSPACE_OVERVIEW,
          suppliers: { ...WORKSPACE_OVERVIEW.suppliers, total: 5, awaitingDecision: 3 },
        },
      },
    });

    // By accessible name, which KPICard builds from the figure the link
    // belongs to — several tiles on this overview say "Review", and it is
    // this one's destination that has to match this one's count.
    const review = await screen.findByRole('link', { name: 'Review: Awaiting a decision' });
    expect(review).toHaveAttribute('href', '/workspace/suppliers?status=awaiting');
  });
});

describe('the supplier directory filtered by that link', () => {
  it('asks the API for the group and lists every status in it', async () => {
    const awaiting = [
      vendorRow('vendor_a', 'Under Review'),
      vendorRow('vendor_b', 'Under Review'),
      vendorRow('vendor_c', 'Pending Approval'),
    ];

    const { apiMock } = renderWithPortal(<SuppliersPage />, {
      plane: 'workspace',
      route: '/workspace/suppliers?status=awaiting',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /vendors': {
          ...listOf('vendors', awaiting),
          filters: EMPTY_WORKSPACE_API['GET /vendors'].filters,
        },
      },
    });

    // Both statuses on the screen — the half the old link dropped included.
    expect(await screen.findByText('vendor_c Pvt Ltd')).toBeInTheDocument();
    expect(screen.getByText('vendor_a Pvt Ltd')).toBeInTheDocument();
    // Scoped to the table: the status filter's own <option> list carries the
    // same words.
    const rows = within(screen.getByRole('table'));
    expect(rows.getAllByText('Pending Approval')).toHaveLength(1);
    expect(rows.getAllByText('Under Review')).toHaveLength(2);

    // And the group went to the API as it arrived, not translated into one
    // status on the way. The server owns what the group holds.
    const asked = apiMock.callsTo('GET', '/vendors').at(-1);
    expect(asked.url).toContain('status=awaiting');
  });

  it('offers the group in its own status filter', async () => {
    renderWithPortal(<SuppliersPage />, {
      plane: 'workspace',
      route: '/workspace/suppliers',
      api: EMPTY_WORKSPACE_API,
    });

    const filter = await screen.findByLabelText('Status');
    // Offered by the API's registry, so a group added there appears here by
    // existing — the screen names no status or group of its own.
    expect(filter).toHaveTextContent('Awaiting a decision');
    expect(filter).toHaveTextContent('Under Review');
  });
});
