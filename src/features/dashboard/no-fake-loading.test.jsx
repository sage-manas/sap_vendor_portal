import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, listOf, summaryOf } from '@/test/fixtures';

import DashboardPage from '@/app/page';

// Issue #289. The Overview held every skeleton up for a fixed 1.2 s after
// each mount — the code said so: "Auto-clear loading state after 1.2s to
// demonstrate skeleton states". A skeleton that is a timer tells the reader
// two untrue things: that data which has already arrived has not, and, once
// the timer fires, that data still in flight has.
//
// Each region now reads the state of the fetch it is actually waiting on, so
// the assertions here are about *rows*, not about elapsed time: a row that
// the API has answered with is on the screen as soon as the render that
// receives it, with no wait beyond it.

const poRow = {
  id: 'PO-2026-0001',
  status: 'Open',
  createdDate: '2026-03-04T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', netValue: 1000, plant: 'P100' }],
};

describe('the supplier Overview does not fake a loading state', () => {
  it('shows an order as soon as the API has answered with it', async () => {
    renderWithPortal(<DashboardPage />, {
      plane: 'supplier',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /pos': listOf('pos', [poRow]),
        'GET /dashboard/summary': summaryOf(),
      },
    });

    // findBy* resolves on the first render that holds the row. Under the
    // timer, this row existed in state for over a second while the table
    // rendered a skeleton over it.
    expect(await screen.findByText('PO-2026-0001')).toBeInTheDocument();
  });

  it('shows the empty state, not a skeleton, once a fetch has answered with nothing', async () => {
    renderWithPortal(<DashboardPage />, {
      plane: 'supplier',
      api: { ...EMPTY_SUPPLIER_API, 'GET /dashboard/summary': summaryOf() },
    });

    // The honest answer for a supplier who has none — and one the fixed timer
    // could only reach after it expired, whether or not anything had loaded.
    expect(
      await screen.findByText(/No purchase orders have been issued to your company yet/)
    ).toBeInTheDocument();
  });

  it('states no payment date it cannot know', async () => {
    renderWithPortal(<DashboardPage />, {
      plane: 'supplier',
      api: { ...EMPTY_SUPPLIER_API, 'GET /dashboard/summary': summaryOf() },
    });

    // "Payments are released 45 days after your buyer approves an invoice"
    // was a hard-coded constant: it came from no setting, no payment terms
    // and no endpoint, and told a supplier when they would be paid. Payment
    // terms are agreed per order, so the empty state points at the order.
    const notice = await screen.findByText(/No payments yet/);
    expect(notice).not.toHaveTextContent('45 days');
    expect(notice).toHaveTextContent(/payment terms on the order/);
  });
});
