import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspaceShipmentsPage from '@/app/workspace/shipments/page';

// The ASN monitor (ASN design screen B1) on the workspace Shipments page, and
// the tenant admin's decisions on it (asn:approve). Other staff see the same
// monitor without the choices.

const base = {
  poId: 'PO-2026-0001', vendorId: 'VND-1', vendorName: 'Northline Polymers', plant: '1100',
  shipDate: '2026-11-20T00:00:00.000Z', estimatedDeliveryDate: '2026-11-22T00:00:00.000Z',
  items: [{ poId: 'PO-2026-0001', line: 10, shippedQuantity: 40 }],
};
const waiting = { ...base, id: 'ASN-100001', status: 'Pending Approval', submittedAt: '2026-11-21T00:00:00.000Z' };
const stuck = { ...base, id: 'ASN-100002', status: 'Submitted', sapError: 'SAP refused: PO item blocked' };
const due = { ...base, id: 'ASN-100003', status: 'Submitted', sapInboundDelivery: '0180000123' };
const late = { ...base, id: 'ASN-100004', status: 'In Transit', estimatedDeliveryDate: '2026-11-18T00:00:00.000Z' };

const MONITOR = {
  date: '2026-11-22', today: '2026-11-22', plant: null, plants: ['1100', '1200'],
  expected: [due], pendingApproval: [waiting], sapErrors: [stuck], overdue: [late],
};

const render = ({ permissions = [...TENANT_SESSION.auth.permissions, 'asn:read', 'asn:approve'], api = {} } = {}) => renderWithPortal(<WorkspaceShipmentsPage />, {
  plane: 'workspace',
  route: '/workspace/shipments',
  session: { ...TENANT_SESSION, auth: { ...TENANT_SESSION.auth, permissions } },
  api: { ...EMPTY_WORKSPACE_API, 'GET /asns/monitor': MONITOR, ...api },
});

const section = (name) => screen.findByRole('region', { name });
const rowIn = async (name, id) => within(await section(name)).getByText(id).closest('tr');

describe('the monitor', () => {
  it('shows each section, with counts', async () => {
    render();

    expect(within(await section('Waiting for approval')).getByText('ASN-100001')).toBeInTheDocument();
    expect(within(await section('SAP errors')).getByText('SAP refused: PO item blocked')).toBeInTheDocument();
    expect(within(await section('Expected today')).getByText('0180000123')).toBeInTheDocument();
    expect(within(await section('Overdue')).getByText('ASN-100004')).toBeInTheDocument();
  });

  it('asks again for one plant', async () => {
    const user = userEvent.setup();
    const { apiMock } = render();

    await user.selectOptions(await screen.findByLabelText('Plant'), '1200');

    await waitFor(() => expect(apiMock.calls.some((call) => call.url.includes('/asns/monitor?plant=1200'))).toBe(true));
  });
});

describe('the tenant admin', () => {
  it('approves a shipment waiting for approval', async () => {
    const user = userEvent.setup();
    const { apiMock } = render({ api: { 'POST /asns/ASN-100001/approve': { asn: { ...waiting, status: 'Submitted' } } } });

    await user.click(within(await rowIn('Waiting for approval', 'ASN-100001')).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/asns/ASN-100001/approve')).toHaveLength(1));
  });

  it('rejects one, with a reason', async () => {
    const user = userEvent.setup();
    const { apiMock } = render({ api: { 'POST /asns/ASN-100001/reject': { asn: { ...waiting, status: 'Rejected' } } } });

    await user.click(within(await rowIn('Waiting for approval', 'ASN-100001')).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject shipment ASN-100001' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject shipment' }));
    expect(apiMock.callsTo('POST', '/asns/ASN-100001/reject')).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason for rejecting' }), 'Wrong plant');
    await user.click(within(dialog).getByRole('button', { name: 'Reject shipment' }));

    await waitFor(() => expect(apiMock.lastBody('POST', '/asns/ASN-100001/reject')).toEqual({ reason: 'Wrong plant' }));
  });

  it('retries SAP for one SAP stopped on', async () => {
    const user = userEvent.setup();
    const { apiMock } = render({ api: { 'POST /asns/ASN-100002/retry': { asn: stuck } } });

    await user.click(within(await rowIn('SAP errors', 'ASN-100002')).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/asns/ASN-100002/retry')).toHaveLength(1));
  });
});

describe('other staff', () => {
  it('see the monitor without the choices', async () => {
    render({ permissions: ['asn:read', 'po:read', 'workspace:read'] });

    const waitingRow = await rowIn('Waiting for approval', 'ASN-100001');
    expect(within(waitingRow).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(await rowIn('SAP errors', 'ASN-100002')).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
