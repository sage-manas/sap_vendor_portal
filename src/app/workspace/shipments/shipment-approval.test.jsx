import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspaceShipmentsPage from '@/app/workspace/shipments/page';

// The tenant admin approves or rejects a supplier's shipment notice before it
// goes to SAP (asn:approve). Other staff see the same list without the choice.

const waiting = {
  id: 'ASN-100001', poId: 'PO-2026-0001', vendorId: 'VND-1', vendorName: 'Northline Polymers',
  status: 'Pending Approval', shipDate: '2026-11-20T00:00:00.000Z', estimatedDeliveryDate: '2099-11-23T00:00:00.000Z',
};
const list = (asns) => ({ asns, pagination: { total: asns.length, page: 1, limit: 200, pages: 1 } });

const render = ({ permissions = [...TENANT_SESSION.auth.permissions, 'asn:read', 'asn:approve'], api = {} } = {}) => renderWithPortal(<WorkspaceShipmentsPage />, {
  plane: 'workspace',
  route: '/workspace/shipments',
  session: { ...TENANT_SESSION, auth: { ...TENANT_SESSION.auth, permissions } },
  api: { ...EMPTY_WORKSPACE_API, 'GET /asns': list([waiting]), ...api },
});

const row = async () => (await screen.findByText('ASN-100001')).closest('tr');

describe('a shipment waiting for approval', () => {
  it('the tenant admin approves it', async () => {
    const user = userEvent.setup();
    const { apiMock } = render({ api: { 'POST /asns/ASN-100001/approve': { asn: { ...waiting, status: 'Submitted' } } } });

    await user.click(within(await row()).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/asns/ASN-100001/approve')).toHaveLength(1));
  });

  it('the tenant admin rejects it, with a reason', async () => {
    const user = userEvent.setup();
    const { apiMock } = render({ api: { 'POST /asns/ASN-100001/reject': { asn: { ...waiting, status: 'Rejected' } } } });

    await user.click(within(await row()).getByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject shipment ASN-100001' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject shipment' }));
    expect(apiMock.callsTo('POST', '/asns/ASN-100001/reject')).toHaveLength(0);

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason for rejecting' }), 'Wrong plant');
    await user.click(within(dialog).getByRole('button', { name: 'Reject shipment' }));

    await waitFor(() => expect(apiMock.lastBody('POST', '/asns/ASN-100001/reject')).toEqual({ reason: 'Wrong plant' }));
  });

  it('other staff see it without the choice', async () => {
    render({ permissions: ['asn:read', 'po:read'] });

    expect(within(await row()).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
