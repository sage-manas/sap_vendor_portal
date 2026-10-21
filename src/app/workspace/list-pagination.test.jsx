import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API, pagedListOf } from '@/test/fixtures';

import WorkspaceInvoicesPage from '@/app/workspace/invoices/page';
import WorkspacePaymentsPage from '@/app/workspace/payments/page';
import WorkspacePurchaseOrdersPage from '@/app/workspace/purchase-orders/page';
import WorkspaceRfqsPage from '@/app/workspace/rfqs/page';

// Issue #281. Each of these four pages asked for `limit: 200` and rendered the
// answer with nothing on screen saying a 201st row existed. The list looked
// complete, so nothing invited the reader to look for the rest — which is why
// this is tested as "the screen states the true total", not merely "a pager
// exists": the caption is the part that stops a partial list from passing as a
// whole one.

const PAGE_SIZE = 50;
const TOTAL = 450;

const rows = (make, count = PAGE_SIZE) => Array.from({ length: count }, (_, index) => make(index + 1));

const invoice = (n) => ({
  id: `INV-${n}`, invoiceNumber: `INV/2026/${n}`, vendorId: 'VND-00001', vendorName: 'Test Supplier Pvt Ltd',
  poId: `PO-2026-${n}`, totalAmount: 1000 + n, currency: 'INR', status: 'Submitted',
  invoiceDate: '2026-04-15T00:00:00.000Z',
});

const po = (n) => ({
  id: `PO-2026-${n}`, sapPoNumber: `45000000${n}`, vendorId: 'VND-00001', vendorName: 'Test Supplier Pvt Ltd',
  items: [], currency: 'INR', status: 'Open', createdDate: '2026-04-15T00:00:00.000Z',
});

const rfq = (n) => ({
  id: `RFQ-2026-${n}`, description: 'Bearings', status: 'Bidding Open',
  invitedVendors: [], bids: [], deadlineDate: '2026-09-19T00:00:00.000Z',
});

const payment = (n) => ({
  id: `PMT-${n}`, vendorId: 'VND-00001', invoiceId: `INV-${n}`, invoiceRef: `INV/2026/${n}`,
  grossAmount: 1000, tdsDeducted: 20, netAmount: 980, utrCode: `UTR-${n}`,
  paymentMethod: 'NEFT', paymentDate: '2026-04-20T00:00:00.000Z',
});

const LISTS = [
  ['invoices', WorkspaceInvoicesPage, '/workspace/invoices', 'GET /invoices', 'invoices', invoice, 'invoices'],
  ['purchase orders', WorkspacePurchaseOrdersPage, '/workspace/purchase-orders', 'GET /pos', 'pos', po, 'orders'],
  ['RFQs', WorkspaceRfqsPage, '/workspace/rfqs', 'GET /rfqs', 'rfqs', rfq, 'RFQs'],
  ['payments', WorkspacePaymentsPage, '/workspace/payments', 'GET /payments', 'payments', payment, 'payments'],
];

describe.each(LISTS)(
  'the workspace %s list, holding one page of a larger set',
  (_label, Page, route, endpoint, key, make, noun) => {
    const render = (search = '') => renderWithPortal(<Page />, {
      plane: 'workspace',
      route: `${route}${search}`,
      api: {
        ...EMPTY_WORKSPACE_API,
        [endpoint]: pagedListOf(key, rows(make), { total: TOTAL, limit: PAGE_SIZE }),
      },
    });

    it('says how many rows there really are, not how many it is showing', async () => {
      render();

      // "Showing 1–50 of 450 invoices" — the sentence the bug was missing.
      const caption = await screen.findByText(
        (_text, element) => element?.tagName === 'P'
          && /Showing\s*1\s*–\s*50\s*of\s*450/.test(element.textContent || ''),
      );
      expect(caption).toBeInTheDocument();
      expect(caption.textContent).toContain(noun);
    });

    it('offers a pager that reaches the rest of the set', async () => {
      render();

      await screen.findByRole('button', { name: 'Next' });
      expect(screen.getByText('1 / 9')).toBeInTheDocument();
      // Nothing before page 1.
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    });

    it('asks the server for the next page rather than slicing what it holds', async () => {
      const { apiMock } = render();
      await screen.findByRole('button', { name: 'Next' });

      await userEvent.click(screen.getByRole('button', { name: 'Next' }));

      await waitFor(() => {
        const [method, path] = endpoint.split(' ');
        const asked = apiMock.callsTo(method, path).map((call) => call.url);
        expect(asked.some((url) => /[?&]page=2\b/.test(url))).toBe(true);
      });
      expect(screen.getByText('2 / 9')).toBeInTheDocument();
    });

    it('never asks for more than a page at a time', async () => {
      const { apiMock } = render();
      await screen.findByRole('button', { name: 'Next' });

      const [method, path] = endpoint.split(' ');
      for (const call of apiMock.callsTo(method, path)) {
        const limit = Number(new URL(call.url).searchParams.get('limit'));
        // The fixed `limit: 200` these pages used to send is the defect: it is
        // both a page the reader is not told about and, past 200 rows, an
        // answer that silently stops.
        expect(limit).toBe(PAGE_SIZE);
      }
    });
  },
);

describe('a complete list', () => {
  it('still states its total, so a complete list reads as complete', async () => {
    renderWithPortal(<WorkspaceInvoicesPage />, {
      plane: 'workspace',
      route: '/workspace/invoices',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /invoices': pagedListOf('invoices', rows(invoice, 12), { total: 12, limit: PAGE_SIZE }),
      },
    });

    await screen.findByText('INV/2026/1');
    const caption = screen.getByText(
      (_text, element) => element?.tagName === 'P'
        && /Showing\s*1\s*–\s*12\s*of\s*12/.test(element.textContent || ''),
    );
    expect(caption).toBeInTheDocument();
    // One page: a pager with both buttons dead is furniture.
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('shows no count at all for an empty list — the empty row has said it', async () => {
    renderWithPortal(<WorkspaceInvoicesPage />, {
      plane: 'workspace',
      route: '/workspace/invoices',
      api: { ...EMPTY_WORKSPACE_API },
    });

    await screen.findByText('No invoices submitted yet.');
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});

describe('an overview KPI tile links to its own list, pre-filtered', () => {
  it('carries ?view=open into the first request, so the list matches the tile', async () => {
    const { apiMock } = renderWithPortal(<WorkspaceInvoicesPage />, {
      plane: 'workspace',
      route: '/workspace/invoices?view=open&minAmount=100000',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /invoices': pagedListOf('invoices', rows(invoice, 38), { total: 38, limit: PAGE_SIZE }),
      },
    });

    await screen.findByText('INV/2026/1');
    const url = apiMock.callsTo('GET', '/invoices').at(-1).url;
    const sent = new URL(url).searchParams;
    expect(sent.get('view')).toBe('open');
    // The threshold tile's own question, kept rather than dropped on arrival.
    expect(sent.get('minAmount')).toBe('100000');
  });

  it('a filter the reader changes goes to the server and resets to page 1', async () => {
    const { apiMock } = renderWithPortal(<WorkspaceRfqsPage />, {
      plane: 'workspace',
      route: '/workspace/rfqs?page=4',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /rfqs': pagedListOf('rfqs', rows(rfq), { total: TOTAL, page: 4, limit: PAGE_SIZE }),
      },
    });

    await screen.findByRole('combobox', { name: 'Show' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'status:Awarded');

    await waitFor(() => {
      const sent = new URL(apiMock.callsTo('GET', '/rfqs').at(-1).url).searchParams;
      expect(sent.get('status')).toBe('Awarded');
      // Page 4 of the unfiltered list is very likely past the end of the
      // filtered one, and an empty table is not an answer to a filter the
      // reader just applied.
      expect(sent.get('page')).toBe('1');
    });
  });
});
