import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { usePortal } from '@/lib/portal-context';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';

// The portal's realtime half: a buyer raises an order, confirms a delivery or
// clears a payment, and the supplier's screen is supposed to say so without a
// refresh. Nothing tested this, and a dropped listener is invisible — the app
// simply goes quiet.
//
// The fake socket in the harness stands in for lib/socket.js and can push a
// server event at the mounted tree (socket.emitServerEvent), so these run the
// real subscription code in PortalProvider.

const Probe = () => {
  const { state } = usePortal();
  return <div data-testid="po-count">{(state.pos || []).length}</div>;
};

const PO = {
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Open',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150 }],
};

const renderProbe = (api = {}) => renderWithPortal(<Probe />, {
  plane: 'supplier',
  route: '/',
  api: { ...EMPTY_SUPPLIER_API, ...api },
});

// The listeners are registered in an effect that waits for the profile, so
// every test waits for the subscription before pushing anything at it.
const subscribed = (socket, event) =>
  waitFor(() => expect(socket.listenerCount(event)).toBeGreaterThan(0), { timeout: 3000 });

describe('realtime updates from the buyer', () => {
  it('subscribes to the events the buyer can raise', async () => {
    const { socket } = renderProbe();

    await subscribed(socket, 'po:new');
    for (const event of ['po:new', 'grn:received', 'payment:cleared', 'chat:message']) {
      expect(socket.listenerCount(event)).toBeGreaterThan(0);
    }
  });

  it('re-reads the orders when a new purchase order arrives', async () => {
    let served = [];
    const { socket, apiMock } = renderProbe({
      'GET /pos': () => ({ pos: served, pagination: { total: served.length, page: 1, limit: 20, pages: 1 } }),
    });

    await subscribed(socket, 'po:new');
    const before = apiMock.callsTo('GET', '/pos').length;

    // The buyer raises the order, then the push arrives.
    served = [PO];
    socket.emitServerEvent('po:new', { id: 'PO-2026-0001' });

    await waitFor(() => expect(apiMock.callsTo('GET', '/pos').length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByTestId('po-count')).toHaveTextContent('1'));
  });

  it('tells the supplier their delivery was accepted', async () => {
    const { socket } = renderProbe();

    await subscribed(socket, 'grn:received');
    socket.emitServerEvent('grn:received', { poId: 'PO-2026-0001' });

    expect(await screen.findByText(/Delivery confirmed for order PO-2026-0001/i)).toBeInTheDocument();
  });

  it('reports a cleared payment with its UTR', async () => {
    const { socket } = renderProbe();

    await subscribed(socket, 'payment:cleared');
    socket.emitServerEvent('payment:cleared', { utrCode: 'UTR12345', netAmount: 1357 });

    expect(await screen.findByText(/UTR12345/)).toBeInTheDocument();
  });

  it('re-reads payments and invoices when one clears', async () => {
    const { socket, apiMock } = renderProbe();

    await subscribed(socket, 'payment:cleared');
    const payments = apiMock.callsTo('GET', '/payments').length;
    const invoices = apiMock.callsTo('GET', '/invoices').length;

    socket.emitServerEvent('payment:cleared', { utrCode: 'UTR12345', netAmount: 1357 });

    // A payment clearing settles the invoice behind it, so both ledgers are
    // stale until they are re-read.
    await waitFor(() => {
      expect(apiMock.callsTo('GET', '/payments').length).toBeGreaterThan(payments);
      expect(apiMock.callsTo('GET', '/invoices').length).toBeGreaterThan(invoices);
    });
  });
});
