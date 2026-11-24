import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';
import AsnPage from '@/app/asn/page';

// The ASN module (ASN design screens V1–V6) through the real page, provider
// stack and API client, against a mocked API.
//
// These walk whole screens (the wizard is four steps of typing), so they get
// more than the default 5s: under a full parallel run they were timing out
// while passing alone.
vi.setConfig({ testTimeout: 20_000 });

const po = (id, overrides = {}, item = {}) => ({
  id,
  vendorId: 'VND-00001',
  status: 'Acknowledged',
  currency: 'INR',
  createdDate: '2026-11-01T00:00:00.000Z',
  items: [{
    line: 10, materialCode: 'MAT-001', description: 'Hex bolts', quantity: 100, grnQuantity: 0, uom: 'EA',
    unitPrice: 10, netValue: 1000, plant: '1100', inTransitQuantity: 0, openToShipQuantity: 100, ...item,
  }],
  ...overrides,
});

const asn = (overrides = {}) => ({
  id: 'ASN-100001',
  poId: 'PO-2026-0001',
  plant: '1100',
  status: 'Submitted',
  submittedAt: '2026-11-20T00:00:00.000Z',
  shipDate: '2026-11-20T00:00:00.000Z',
  estimatedDeliveryDate: '2026-11-23T00:00:00.000Z',
  invoiceReference: 'INV/2526/0871',
  vehicleNumber: 'HR55AB1234',
  carrierName: 'Safexpress',
  items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: 40, receivedQuantity: null, receiptVariance: null }],
  documents: [],
  ...overrides,
});

const list = (key, rows) => ({ [key]: rows, pagination: { total: rows.length, page: 1, limit: 20, pages: 1 } });

const render = (route, { pos = [po('PO-2026-0001')], asns = [], drafts = [], api = {} } = {}) => renderWithPortal(<AsnPage />, {
  plane: 'supplier',
  route,
  api: {
    ...EMPTY_SUPPLIER_API,
    'GET /pos': list('pos', pos),
    'GET /asns': list('asns', asns),
    'GET /asn-drafts': { drafts },
    ...api,
  },
});

const today = new Date().toISOString().slice(0, 10);

describe('the ASN dashboard', () => {
  it('lists shipments, with the orders on each', async () => {
    render('/asn', { asns: [asn({ items: [
      { poId: 'PO-2026-0001', line: 10, shippedQuantity: 40 },
      { poId: 'PO-2026-0002', line: 10, shippedQuantity: 5 },
    ] })] });

    const row = (await screen.findByText('ASN-100001')).closest('tr');
    expect(within(row).getByText('PO-2026-0001, PO-2026-0002')).toBeInTheDocument();
    expect(within(row).getByText('Submitted')).toBeInTheDocument();
  });

  it('keeps drafts on their own tab, to resume', async () => {
    const user = userEvent.setup();
    const { navigation } = render('/asn', { drafts: [{
      pk: '11111111-1111-4111-8111-111111111111', poId: 'PO-2026-0001', step: 3, updatedAt: '2026-11-21T06:54:00.000Z',
      payload: { invoiceReference: 'INV/9' },
    }] });

    await user.click(await screen.findByRole('tab', { name: 'Drafts (1)' }));
    await user.click(await screen.findByRole('button', { name: 'Resume' }));

    expect(navigation.push).toHaveBeenCalledWith('/asn?draft=11111111-1111-4111-8111-111111111111');
  });
});

describe('creating an ASN', () => {
  // Steps 1 to 3 for one order's line, filled to pass every rule.
  const fillToReview = async (user, { invoiceValue = '1180' } = {}) => {
    // Started from the order: its open line is already chosen at its plant.
    await user.click(await screen.findByRole('button', { name: 'Next: quantities' }));
    const qty = await screen.findByLabelText('Quantity to ship for PO-2026-0001 line 10');
    await user.clear(qty);
    await user.type(qty, '40');
    await user.click(screen.getByRole('button', { name: 'Next: shipment and documents' }));

    await user.type(await screen.findByLabelText(/^Invoice \/ challan no\./), 'INV/2526/0871');
    await user.type(screen.getByLabelText(/^Invoice date/), today);
    await user.type(screen.getByLabelText(/^Invoice total/), invoiceValue);
    // Exact: "Transporter GSTIN" is a field too.
    await user.type(screen.getByLabelText(/^Transporter( \*)?$/), 'Safexpress');
    await user.type(screen.getByLabelText(/^Vehicle no\./), 'hr55ab1234');
  };

  const invoiceUpload = { documentId: '22222222-2222-4222-8222-222222222222', originalName: 'invoice.pdf', size: 1000, fileName: 'x.pdf' };

  it('walks the four steps and submits one shipment with the lines and details entered', async () => {
    const user = userEvent.setup();
    const { apiMock, navigation } = render('/asn?new=1&po=PO-2026-0001', {
      api: {
        'POST /uploads': invoiceUpload,
        'POST /asns': { message: 'ok', asn: asn({ id: 'ASN-200001' }) },
      },
    });

    await fillToReview(user);
    const file = new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByRole('group', { name: 'Invoice copy' }).querySelector('input[type="file"]'), file);
    expect(await screen.findByText('invoice.pdf')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Next: review and submit' }));
    await user.click(await screen.findByRole('button', { name: 'Submit ASN' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/asns')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/asns')).toMatchObject({
      invoiceReference: 'INV/2526/0871',
      invoiceValue: 1180,
      carrierName: 'Safexpress',
      vehicleNumber: 'hr55ab1234',
      items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: 40 }],
      documentIds: [invoiceUpload.documentId],
    });
    expect(navigation.push).toHaveBeenLastCalledWith('/asn?id=ASN-200001');
  });

  it('will not move past a step with a mistake on it, and says where', async () => {
    const user = userEvent.setup();
    render('/asn?new=1&po=PO-2026-0001');

    await fillToReview(user, { invoiceValue: '486750' });
    await user.click(screen.getByRole('button', { name: 'Next: review and submit' }));

    // Above ₹50,000: the e-way bill is required; the invoice copy always is.
    expect(await screen.findByText(/Required: the invoice is worth more than ₹50,000/)).toBeInTheDocument();
    expect(screen.getByText('Attach the invoice copy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit ASN' })).not.toBeInTheDocument();
  });

  it('refuses more than is open on a line', async () => {
    const user = userEvent.setup();
    render('/asn?new=1&po=PO-2026-0001', { pos: [po('PO-2026-0001', {}, { inTransitQuantity: 70, openToShipQuantity: 30 })] });

    await user.click(await screen.findByRole('button', { name: 'Next: quantities' }));
    const qty = await screen.findByLabelText('Quantity to ship for PO-2026-0001 line 10');
    expect(qty).toHaveValue(30);
    await user.clear(qty);
    await user.type(qty, '31');
    await user.click(screen.getByRole('button', { name: 'Next: shipment and documents' }));

    expect(await screen.findByText('Only 30 left to ship on this line')).toBeInTheDocument();
  });

  it('offers only one plant\'s lines at a time', async () => {
    const user = userEvent.setup();
    render('/asn?new=1', { pos: [
      po('PO-2026-0001'),
      po('PO-2026-0002', {}, { plant: '1200' }),
    ] });

    await user.selectOptions(await screen.findByLabelText(/^Plant/), '1200');

    const table = screen.getByRole('table', { name: 'Open PO lines' });
    expect(within(table).getByText('PO-2026-0002')).toBeInTheDocument();
    expect(within(table).queryByText('PO-2026-0001')).not.toBeInTheDocument();
  });

  it('saves a draft at any step, without an ASN number', async () => {
    const user = userEvent.setup();
    const { apiMock } = render('/asn?new=1&po=PO-2026-0001', {
      api: { 'POST /asn-drafts': { pk: '33333333-3333-4333-8333-333333333333', step: 1, payload: {}, updatedAt: '2026-11-21T06:54:00.000Z' } },
    });

    await user.click(await screen.findByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/asn-drafts')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/asn-drafts')).toMatchObject({
      poId: 'PO-2026-0001',
      step: 1,
      payload: { items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: '' }] },
    });
    expect(await screen.findByText(/^Draft saved/)).toBeInTheDocument();
  });

  it('resumes a draft at the step it was saved on, and submits through it', async () => {
    const user = userEvent.setup();
    const pk = '44444444-4444-4444-8444-444444444444';
    const { apiMock } = render(`/asn?draft=${pk}`, {
      drafts: [{
        pk, poId: 'PO-2026-0001', step: 4, updatedAt: '2026-11-21T06:54:00.000Z',
        payload: {
          invoiceReference: 'INV/9', invoiceDate: today, invoiceValue: 1180, carrierName: 'Safexpress', trackingNumber: 'LR1',
          shipDate: today, estimatedDeliveryDate: today,
          items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: '12' }],
          attachments: { invoiceCopy: { documentId: '55555555-5555-4555-8555-555555555555', originalName: 'inv.pdf' } },
        },
      }],
      api: {
        [`PUT /asn-drafts/${pk}`]: { pk, step: 4, payload: {}, updatedAt: '2026-11-21T07:00:00.000Z' },
        [`POST /asn-drafts/${pk}/submit`]: { message: 'ok', asn: asn({ id: 'ASN-300001' }) },
      },
    });

    expect(await screen.findByRole('region', { name: 'Review and submit' })).toBeInTheDocument();
    expect(screen.getByText('12 EA')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit ASN' }));

    await waitFor(() => expect(apiMock.callsTo('POST', `/asn-drafts/${pk}/submit`)).toHaveLength(1));
    expect(apiMock.lastBody('PUT', `/asn-drafts/${pk}`).payload).toMatchObject({ invoiceReference: 'INV/9', items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: '12' }] });
  });
});

describe('one shipment', () => {
  it('shows its lines, what SAP received, and the shortfall', async () => {
    render('/asn?id=ASN-100001', { asns: [asn({
      status: 'Received', sapInboundDelivery: '0180000123',
      items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: 40, receivedQuantity: 38, receiptVariance: -2 }],
    })] });

    expect(await screen.findByRole('heading', { level: 1, name: 'ASN-100001' })).toBeInTheDocument();
    expect(screen.getByText('Inbound delivery 0180000123 in SAP')).toBeInTheDocument();
    expect(screen.getByText('-2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel shipment' })).not.toBeInTheDocument();
  });

  it('can be cancelled, with a reason, before anything is received', async () => {
    const user = userEvent.setup();
    const { apiMock } = render('/asn?id=ASN-100001', {
      asns: [asn()],
      api: { 'POST /asns/ASN-100001/cancel': { message: 'Shipment cancelled.', asn: asn({ status: 'Cancelled' }) } },
    });

    await user.click(await screen.findByRole('button', { name: 'Cancel shipment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel shipment ASN-100001' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason for cancelling' }), 'Vehicle did not leave');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel shipment' }));

    await waitFor(() => expect(apiMock.lastBody('POST', '/asns/ASN-100001/cancel')).toEqual({ reason: 'Vehicle did not leave' }));
  });
});

describe('approval by the buyer', () => {
  it('shows a shipment waiting for approval, which can still be withdrawn', async () => {
    render('/asn?id=ASN-100001', { asns: [asn({ status: 'Pending Approval' })] });

    expect(await screen.findByText("Waiting for your buyer's approval")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel shipment' })).toBeInTheDocument();
  });

  it('shows why a shipment was rejected, and what to do', async () => {
    render('/asn?id=ASN-100001', { asns: [asn({ status: 'Rejected', rejectionReason: 'Wrong plant' })] });

    expect(await screen.findByText(/Rejected by your buyer: Wrong plant\. Change it and send it again\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel shipment' })).not.toBeInTheDocument();
  });
});
