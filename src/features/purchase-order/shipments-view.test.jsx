import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import PurchaseOrdersPage from '@/app/pos/page';

// An order can ship in parts, and a shipment notice can be withdrawn. What the
// supplier sees has to follow the API's figures (openToShipQuantity), not
// re-derive them from ordered less received — that ignores what is already
// on its way.

const po = (overrides = {}, item = {}) => ({
  id: 'PO-2026-0001',
  vendorId: 'VND-00001',
  status: 'Dispatched',
  currency: 'INR',
  createdDate: '2026-01-01T00:00:00.000Z',
  items: [{
    line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, grnQuantity: 0,
    uom: 'EA', unitPrice: 11.5, netValue: 1150, inTransitQuantity: 40, openToShipQuantity: 60, ...item,
  }],
  ...overrides,
});

const asn = (overrides = {}) => ({
  id: 'ASN-100001',
  poId: 'PO-2026-0001',
  status: 'Submitted',
  shipDate: '2026-02-01T00:00:00.000Z',
  items: [{ line: 10, shippedQuantity: 40, receivedQuantity: null, receiptVariance: null }],
  documents: [],
  ...overrides,
});

const renderLedger = (pos, asns = [], api = {}) => renderWithPortal(<PurchaseOrdersPage />, {
  plane: 'supplier',
  route: '/pos',
  api: {
    ...EMPTY_SUPPLIER_API,
    'GET /pos': { pos, pagination: { total: pos.length, page: 1, limit: 20, pages: 1 } },
    'GET /asns': { asns, pagination: { total: asns.length, page: 1, limit: 20, pages: 1 } },
    ...api,
  },
});

const row = async (id) => (await screen.findByText(id, {}, { timeout: 4000 })).closest('tr');

describe('a partly shipped order', () => {
  it('can still be shipped while a line has quantity open', async () => {
    renderLedger([po()]);

    expect(within(await row('PO-2026-0001')).getByRole('button', { name: 'Send shipment' })).toBeInTheDocument();
  });

  it('cannot once everything is on its way', async () => {
    renderLedger([po({}, { inTransitQuantity: 100, openToShipQuantity: 0 })]);

    expect(within(await row('PO-2026-0001')).queryByRole('button', { name: 'Send shipment' })).not.toBeInTheDocument();
  });
});

describe('cancelling a shipment from the order', () => {
  it('asks for a reason, then sends it', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderLedger([po()], [asn()], {
      'POST /pos/PO-2026-0001/asn/ASN-100001/cancel': { message: 'Shipment cancelled.', asn: asn({ status: 'Cancelled' }) },
    });

    await user.click(await row('PO-2026-0001'));
    await user.click(await screen.findByRole('tab', { name: 'Delivery status' }));
    await user.click(within(await row('ASN-100001')).getByRole('button', { name: 'Cancel' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancel shipment ASN-100001' });
    // No reason, no request.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel shipment' }));
    expect(apiMock.callsTo('POST', '/pos/PO-2026-0001/asn/ASN-100001/cancel')).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason for cancelling' }), 'Vehicle did not leave');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel shipment' }));

    await waitFor(() => expect(apiMock.lastBody('POST', '/pos/PO-2026-0001/asn/ASN-100001/cancel')).toEqual({ reason: 'Vehicle did not leave' }));
  });

  it('shows the inbound delivery SAP created, and a dash where it made none', async () => {
    const user = userEvent.setup();
    renderLedger([po()], [asn({ sapInboundDelivery: '0180000123' }), asn({ id: 'ASN-100002' })]);

    await user.click(await row('PO-2026-0001'));
    await user.click(await screen.findByRole('tab', { name: 'Delivery status' }));

    expect(within(await row('ASN-100001')).getByText('0180000123')).toBeInTheDocument();
    expect(within(await row('ASN-100002')).getByTitle('SAP has no inbound delivery for this shipment')).toBeInTheDocument();
  });

  it('offers no cancel on a shipment SAP has received', async () => {
    const user = userEvent.setup();
    renderLedger([po()], [asn({ status: 'Received', items: [{ line: 10, shippedQuantity: 40, receivedQuantity: 38, receiptVariance: -2 }] })]);

    await user.click(await row('PO-2026-0001'));
    await user.click(await screen.findByRole('tab', { name: 'Delivery status' }));

    expect(within(await row('ASN-100001')).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });
});

describe('shipment drafts', () => {
  it('saves the form as it stands, with no ASN number asked for', async () => {
    const user = userEvent.setup();
    const { apiMock } = renderLedger([po()], [], {
      'GET /asn-drafts': { drafts: [] },
      'POST /asn-drafts': { pk: '11111111-1111-4111-8111-111111111111', poId: 'PO-2026-0001', step: 1, payload: {}, updatedAt: '2026-11-21T06:54:00.000Z' },
    });

    await user.click(await row('PO-2026-0001'));
    await user.click(await screen.findByRole('tab', { name: 'Send shipment' }));
    await user.type(screen.getByLabelText(/^Carrier/), 'Safexpress');
    await user.type(screen.getByLabelText(/^Invoice number/), 'INV/26/9');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/asn-drafts')).toHaveLength(1));
    const body = apiMock.lastBody('POST', '/asn-drafts');
    expect(body.poId).toBe('PO-2026-0001');
    expect(body.payload).toMatchObject({ carrierName: 'Safexpress', invoiceReference: 'INV/26/9', items: [{ line: 10, shippedQuantity: '60' }] });
    expect(await screen.findByText(/^Draft saved/)).toBeInTheDocument();
  });

  it('resumes a saved draft into the form', async () => {
    const user = userEvent.setup();
    renderLedger([po()], [], {
      'GET /asn-drafts': { drafts: [{
        pk: '22222222-2222-4222-8222-222222222222', poId: 'PO-2026-0001', step: 1, updatedAt: '2026-11-20T10:00:00.000Z',
        payload: { carrierName: 'Blue Dart', invoiceReference: 'INV/26/7', items: [{ line: 10, shippedQuantity: '12' }] },
      }] },
    });

    await user.click(await row('PO-2026-0001'));
    await user.click(await screen.findByRole('tab', { name: 'Send shipment' }));
    await user.click(within(await screen.findByRole('region', { name: 'Drafts for this order' })).getByRole('button', { name: 'Resume' }));

    expect(screen.getByLabelText(/^Carrier/)).toHaveValue('Blue Dart');
    expect(screen.getByLabelText(/^Invoice number/)).toHaveValue('INV/26/7');
    expect(screen.getByLabelText('Quantity to dispatch for line 10')).toHaveValue(12);
  });
});
