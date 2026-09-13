import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import PurchaseOrdersPage from '@/app/pos/page';

// The purchase-order detail view's heading outline. supplier-routes.test.jsx
// guards the list view's outline, but it renders the list, so it never reached
// this branch — where every section title sat at h4 directly under the h2, and
// three status messages ("No delivery confirmed yet" and the like) were
// headings a screen-reader user would land on when moving by heading.
//
// Which sections exist depends on the order's state, so each case below puts
// an order in the state that renders a different part of the view, then walks
// all three tabs.

const po = (overrides) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Open',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  sapSyncState: 'synced',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150 }],
  ...overrides,
});

const TABS = ['1. Order details', '2. Send shipment', '3. Delivery status'];

const GRN = {
  id: 'GRN-000001',
  poId: 'PO-2026-0001',
  vendorId: 'VND-00001',
  sapMigoDoc: '5000012345',
  postingDate: '2026-02-01T00:00:00.000Z',
  receivedBy: 'Stores',
  invoiceSubmitted: false,
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', receivedQuantity: 100, acceptedQuantity: 95, rejectedQuantity: 5, uom: 'EA' }],
};

const withGrn = { 'GET /grns': { grns: [GRN], pagination: { total: 1, page: 1, limit: 20, pages: 1 } } };

const outline = () => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
  .map((node) => ({ level: Number(node.tagName[1]), text: node.textContent.trim() }));

const expectNoSkippedLevel = (tab) => {
  const levels = outline().map((h) => h.level);
  expect(levels[0], `first heading on "${tab}"`).toBe(2);
  levels.forEach((level, i) => {
    if (i === 0) return;
    expect(level - levels[i - 1], `heading ${i} on "${tab}": ${JSON.stringify(outline())}`)
      .toBeLessThanOrEqual(1);
  });
};

const openDetail = async (order, api = {}) => {
  const user = userEvent.setup();
  renderWithPortal(<PurchaseOrdersPage />, {
    plane: 'supplier',
    route: '/pos',
    api: {
      ...EMPTY_SUPPLIER_API,
      'GET /pos': { pos: [order], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
      ...api,
    },
  });
  await user.click(await screen.findByRole('button', { name: 'View PO' }, { timeout: 4000 }));
  await screen.findByRole('heading', { level: 2, name: /Purchase Order: PO-2026-0001/ });
  return user;
};

const walkTabs = async (user) => {
  for (const tab of TABS) {
    await user.click(screen.getByRole('button', { name: tab }));
    await waitFor(() => expectNoSkippedLevel(tab));
  }
};

describe('the purchase-order detail view outline', () => {
  it('has no skipped level on any tab for an order awaiting acknowledgement', async () => {
    const user = await openDetail(po({ status: 'Open' }));
    await walkTabs(user);
  });

  it('nests the shipment form\'s sub-sections one level under it', async () => {
    const user = await openDetail(po({ status: 'Acknowledged' }));
    await user.click(screen.getByRole('button', { name: '2. Send shipment' }));

    const form = await screen.findByRole('heading', { name: /Advanced Shipping Notice Form/i });
    expect(form.tagName).toBe('H3');
    expect(screen.getByRole('heading', { name: /Dispatch Qty Allocation/i }).tagName).toBe('H4');
    await walkTabs(user);
  });

  it('has no skipped level once the shipment has gone out', async () => {
    const user = await openDetail(po({ status: 'Dispatched' }));
    await walkTabs(user);
  });

  it('nests the inspection result one level under the delivery receipt', async () => {
    const user = await openDetail(po({ status: 'Delivered' }), withGrn);
    await user.click(screen.getByRole('button', { name: '3. Delivery status' }));

    expect((await screen.findByRole('heading', { name: 'Delivery receipt' })).tagName).toBe('H3');
    expect(screen.getByRole('heading', { name: /Items received/i }).tagName).toBe('H4');
    await walkTabs(user);
  });

  it('keeps status messages out of the outline', async () => {
    const user = await openDetail(po({ status: 'Open' }));

    // Each of these is a call to action or an empty state. Styled like a
    // heading is fine; being one puts it in a screen reader's heading list as
    // though it were a section to read.
    await user.click(screen.getByRole('button', { name: '2. Send shipment' }));
    expect(await screen.findByText('PO Acknowledgement Required')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'PO Acknowledgement Required' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '3. Delivery status' }));
    expect(await screen.findByText('No delivery confirmed yet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No delivery confirmed yet' })).not.toBeInTheDocument();
  });
});

// The invoice screen (Ready to Invoice -> Create invoice) is a separate view
// from the detail tabs above. It had no page heading in either state: before
// submitting, the first heading was the three-way-match banner as an h4; after,
// it was "Invoice submitted" as an h3 with nothing above it.
describe('the invoice screen outline', () => {
  const openInvoice = async () => {
    const user = userEvent.setup();
    const { apiMock } = renderWithPortal(<PurchaseOrdersPage />, {
      plane: 'supplier',
      route: '/pos',
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /pos': { pos: [po({ status: 'Delivered' })], pagination: { total: 1, page: 1, limit: 20, pages: 1 } },
        ...withGrn,
        'POST /invoices': { message: 'Invoice submitted', invoice: { id: 'INV-000001' } },
      },
    });
    await user.click(await screen.findByRole('button', { name: /Ready to Invoice/i }, { timeout: 4000 }));
    await user.click(await screen.findByRole('button', { name: /Create invoice/i }));
    await screen.findByRole('heading', { level: 2, name: 'Invoice for GRN-000001' });
    return { user, apiMock };
  };

  it('names itself and keeps the match banner out of the outline, before submitting', async () => {
    await openInvoice();

    expectNoSkippedLevel('invoice form');
    expect(screen.getByText('Order, delivery and invoice all match')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Order, delivery and invoice all match' })).not.toBeInTheDocument();
  });

  it('keeps its page heading once the invoice is submitted', async () => {
    const { user, apiMock } = await openInvoice();

    await user.click(screen.getByRole('button', { name: /Submit invoice/i }));
    // The screen waits a deliberate 1.5s before showing the submitted state.
    await screen.findByRole('heading', { level: 3, name: 'Invoice submitted' }, { timeout: 4000 });

    expect(apiMock.callsTo('POST', '/invoices')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'Invoice for GRN-000001' })).toBeInTheDocument();
    expectNoSkippedLevel('invoice submitted');
  });
});
