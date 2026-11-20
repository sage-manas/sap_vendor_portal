import { describe, it, expect } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePortal } from '@/lib/portal-context';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';

// The advance shipping notice submission that moves goods after an order
// exists.
//
// This drives PortalProvider's real handler rather than the button that calls
// it — the shipment form lives several clicks inside the PO detail view, and
// what is worth pinning here is the payload, not the route to the button. The
// chain under test is still the real one: handler → feature hook → service →
// api-client → fetch. That the pages hosting this button render at all is
// covered by the route smoke tests.

const PO = {
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Acknowledged',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [
    { line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, uom: 'EA', unitPrice: 11.5, netValue: 1150 },
    { line: 20, materialCode: 'MAT-002', description: 'Nuts M8', quantity: 200, uom: 'EA', unitPrice: 3.8, netValue: 760 },
  ],
};

// A consumer that exposes the provider's handler as a button, so each test
// triggers it through React the way the real screens do.
const Harness = ({ onReady }) => {
  const portal = usePortal();
  onReady?.(portal);
  return (
    <div>
      <button type="button" onClick={() => portal.setAsnForm({
        carrierName: 'BlueDart Express',
        trackingNumber: 'BD-778899',
        vehicleNumber: 'MH-12-AB-4455',
        invoiceReference: 'INV-778899',
        invoiceDate: '2026-01-31',
        invoiceValue: '1357.00',
        shipDate: '2026-02-01',
        estimatedDeliveryDate: '2026-02-05',
        items: { 10: 100, 20: 150 },
      })}>
        fill asn
      </button>
      <button type="button" onClick={() => portal.handleAsnSubmit(PO)}>send asn</button>
    </div>
  );
};

const renderHarness = (api) => renderWithPortal(<Harness />, {
  plane: 'supplier',
  route: '/pos',
  api: { ...EMPTY_SUPPLIER_API, ...api },
});

describe('raising an advance shipping notice', () => {
  it('sends the supplier\'s invoice, as a number for its value', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderHarness({
      'POST /pos/PO-2026-0001/asn': { message: 'ASN created', asn: { id: 'ASN-000001' } },
    });

    await user.click(await screen.findByRole('button', { name: 'fill asn' }));
    await user.click(screen.getByRole('button', { name: 'send asn' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/pos/PO-2026-0001/asn')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/pos/PO-2026-0001/asn')).toMatchObject({
      invoiceReference: 'INV-778899',
      invoiceDate: '2026-01-31',
      invoiceValue: 1357,
    });
  });

  it('sends the carrier, dates and per-line shipped quantities', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderHarness({
      'POST /pos/PO-2026-0001/asn': { message: 'ASN created', asn: { id: 'ASN-000001' } },
    });

    await user.click(await screen.findByRole('button', { name: 'fill asn' }));
    await user.click(screen.getByRole('button', { name: 'send asn' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/pos/PO-2026-0001/asn')).toHaveLength(1));

    const body = apiMock.lastBody('POST', '/pos/PO-2026-0001/asn');
    expect(body).toMatchObject({
      carrierName: 'BlueDart Express',
      trackingNumber: 'BD-778899',
      vehicleNumber: 'MH-12-AB-4455',
      shipDate: '2026-02-01',
      estimatedDeliveryDate: '2026-02-05',
    });
    // The order is named by the URL; the API refuses a body key it does not
    // declare, so `poId` must not ride along in the body too.
    expect(body).not.toHaveProperty('poId');
    // A part shipment is the interesting case: line 20 ships 150 of 200, and
    // the quantity the supplier typed must survive rather than the ordered
    // quantity being sent back.
    expect(body.items).toEqual([
      { line: 10, shippedQuantity: 100 },
      { line: 20, shippedQuantity: 150 },
    ]);
  });

  // This used to be pinned the other way round, as "falls back to shipping
  // the ordered quantity for a line left blank": clearing a field put the
  // line's whole ordered quantity on the shipment, the opposite of what
  // clearing it means.
  it('leaves a line the supplier left blank off the shipment', async () => {
    const user = userEvent.setup();
    let portal;
    const { apiMock } = renderWithPortal(<Harness onReady={(p) => { portal = p; }} />, {
      plane: 'supplier',
      route: '/pos',
      api: { ...EMPTY_SUPPLIER_API, 'POST /pos/PO-2026-0001/asn': { message: 'ASN created', asn: { id: 'ASN-000001' } } },
    });

    await screen.findByRole('button', { name: 'send asn' });
    await act(async () => {
      portal.setAsnForm({ shipDate: '2026-02-01', estimatedDeliveryDate: '2026-02-05', items: { 10: 40, 20: '' } });
    });
    await user.click(screen.getByRole('button', { name: 'send asn' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/pos/PO-2026-0001/asn')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/pos/PO-2026-0001/asn').items).toEqual([
      { line: 10, shippedQuantity: 40 },
    ]);
  });
});

describe('cancelling a shipment', () => {
  it('posts the reason to the shipment\'s own cancel endpoint', async () => {
    let portal;
    const { apiMock } = renderWithPortal(<Harness onReady={(p) => { portal = p; }} />, {
      plane: 'supplier',
      route: '/pos',
      api: {
        ...EMPTY_SUPPLIER_API,
        'POST /pos/PO-2026-0001/asn/ASN-000001/cancel': { message: 'Shipment cancelled.', asn: { id: 'ASN-000001', status: 'Cancelled' } },
      },
    });

    await screen.findByRole('button', { name: 'send asn' });
    await act(async () => {
      await portal.poHook.cancelASN('PO-2026-0001', 'ASN-000001', 'Vehicle did not leave');
    });

    expect(apiMock.lastBody('POST', '/pos/PO-2026-0001/asn/ASN-000001/cancel')).toEqual({ reason: 'Vehicle did not leave' });
  });
});
