import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePortal } from '@/lib/portal-context';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';

// The two submissions that move goods and money after an order exists: the
// advance shipping notice, and the invoice raised against a goods receipt.
//
// These drive PortalProvider's real handlers rather than the buttons that call
// them — the shipment form lives several clicks inside the PO detail view, and
// what is worth pinning here is the payload, not the route to the button. The
// chain under test is still the real one: handler → feature hook → service →
// api-client → fetch. That the pages hosting these buttons render at all is
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

const GRN = {
  id: 'GRN-000001',
  poId: 'PO-2026-0001',
  vendorId: 'VND-00001',
  postingDate: '2026-02-01T00:00:00.000Z',
  items: [{ line: 10, materialCode: 'MAT-001', receivedQuantity: 100, acceptedQuantity: 100 }],
};

// A consumer that exposes the provider's handlers as buttons, so each test
// triggers them through React the way the real screens do.
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
        shipDate: '2026-02-01',
        estimatedDeliveryDate: '2026-02-05',
        items: { 10: 100, 20: 150 },
      })}>
        fill asn
      </button>
      <button type="button" onClick={() => portal.handleAsnSubmit(PO)}>send asn</button>
      <button type="button" onClick={() => portal.invoiceHook.submitInvoice({
        poId: PO.id,
        grnId: GRN.id,
        invoiceNumber: 'SUP/2026/001',
        invoiceDate: '2026-02-06',
        items: [{ line: 10, materialCode: 'MAT-001', description: 'Hex bolts M8', quantity: 100, unitPrice: 11.5, amount: 1150 }],
        subTotal: 1150,
        taxAmount: 207,
        totalAmount: 1357,
      })}>send invoice</button>
    </div>
  );
};

const renderHarness = (api) => renderWithPortal(<Harness />, {
  plane: 'supplier',
  route: '/pos',
  api: { ...EMPTY_SUPPLIER_API, ...api },
});

describe('raising an advance shipping notice', () => {
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
    // A part shipment is the interesting case: line 20 ships 150 of 200, and
    // the quantity the supplier typed must survive rather than the ordered
    // quantity being sent back.
    expect(body.items).toEqual([
      { line: 10, shippedQuantity: 100 },
      { line: 20, shippedQuantity: 150 },
    ]);
  });

  it('falls back to shipping the ordered quantity for a line left blank', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderHarness({
      'POST /pos/PO-2026-0001/asn': { message: 'ASN created', asn: { id: 'ASN-000001' } },
    });

    // No "fill asn" click: the form is untouched, so every line defaults.
    await user.click(await screen.findByRole('button', { name: 'send asn' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/pos/PO-2026-0001/asn')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/pos/PO-2026-0001/asn').items).toEqual([
      { line: 10, shippedQuantity: 100 },
      { line: 20, shippedQuantity: 200 },
    ]);
  });
});

describe('submitting an invoice against a goods receipt', () => {
  it('sends the invoice with the GRN it bills', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderHarness({
      'POST /invoices': { message: 'Invoice submitted', invoice: { id: 'INV-000001' } },
    });

    await user.click(await screen.findByRole('button', { name: 'send invoice' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/invoices')).toHaveLength(1));

    expect(apiMock.lastBody('POST', '/invoices')).toMatchObject({
      poId: 'PO-2026-0001',
      grnId: 'GRN-000001',
      invoiceNumber: 'SUP/2026/001',
      subTotal: 1150,
      taxAmount: 207,
      totalAmount: 1357,
    });
  });

  it('survives a rejected invoice without taking the portal down', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderHarness({
      'POST /invoices': { status: 400, body: { error: 'Invoice already submitted for this GRN' } },
    });

    await user.click(await screen.findByRole('button', { name: 'send invoice' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/invoices')).toHaveLength(1));
    // useInvoices swallows the failure (it logs and returns); the assertion
    // that matters here is that the tree is still mounted and usable.
    expect(screen.getByRole('button', { name: 'send invoice' })).toBeInTheDocument();
  });
});
