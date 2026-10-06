import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspaceShipmentsPage from '@/app/workspace/shipments/page';
import { navFor } from '@/lib/workspaceNav';

// Finding 4.1. There was no staff shipments screen because there could not be
// one: `GET /api/asns` opened with `requireVendorScope`, which answers 400 to
// any caller that is not a supplier. The people the goods are inbound to were
// the only ones who could not see what was coming — despite all three staff
// roles already holding `asn:read`.

const ASN = {
  id: 'ASN-826291',
  poId: 'PO-2026-0001',
  vendorId: 'vendor_test_001',
  vendorName: null,
  status: 'Submitted',
  shipDate: '2026-02-01T00:00:00.000Z',
  estimatedDeliveryDate: '2026-02-06T00:00:00.000Z',
  carrierName: 'Blue Dart Express',
  trackingNumber: 'BD123456789',
  sapInboundDelivery: null,
  items: [{ line: 10, quantity: 100 }],
};

const withAsns = (...asns) => ({
  ...EMPTY_WORKSPACE_API,
  'GET /auth/me': TENANT_SESSION,
  'GET /asns': { asns, pagination: { total: asns.length, page: 1, limit: 200, pages: 1 } },
});

const renderPage = (api) => renderWithPortal(<WorkspaceShipmentsPage />, {
  plane: 'workspace', route: '/workspace/shipments', api,
});

describe('the workspace shipments list', () => {
  it('lists what suppliers have dispatched', async () => {
    renderPage(withAsns(ASN));

    expect(await screen.findByText('ASN-826291')).toBeInTheDocument();
    expect(screen.getByText('Blue Dart Express')).toBeInTheDocument();
    expect(screen.getByText('BD123456789')).toBeInTheDocument();
    expect(screen.getByText('PO-2026-0001')).toBeInTheDocument();
  });

  it('reads the paginated response shape, not a bare array', async () => {
    // The endpoint used to answer a bare array; it now answers
    // { asns, pagination } like every other list.
    renderPage(withAsns(ASN));

    expect(await screen.findByText('ASN-826291')).toBeInTheDocument();
  });

  it('says so, rather than showing an empty table, when nothing is in transit', async () => {
    renderPage(withAsns());

    expect(await screen.findByText(/no shipments dispatched yet/i)).toBeInTheDocument();
  });

  it('shows a dash where the supplier gave no tracking number', async () => {
    // A supplier is not obliged to supply one. Absent reads as absent.
    renderPage(withAsns({ ...ASN, trackingNumber: null, carrierName: null }));

    await screen.findByText('ASN-826291');
    const row = screen.getByText('ASN-826291').closest('tr');
    expect(row.textContent).toContain('—');
  });

  it('shows a dash for an SAP inbound delivery SAP has not issued', async () => {
    // Never invented here — the rule PROJECT_CONTEXT.md §5.6 records, and the
    // frontend half of it that issue #121 cleaned up.
    renderPage(withAsns(ASN));

    await screen.findByText('ASN-826291');
    expect(screen.getByText('ASN-826291').closest('tr').textContent).not.toMatch(/1800\d{6}/);
  });

  it('routes a row through to the supplier it belongs to', async () => {
    const { navigation } = renderPage(withAsns(ASN));

    await userEvent.click((await screen.findByText('ASN-826291')).closest('tr'));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/workspace/suppliers/vendor_test_001'));
  });

  it('identifies the supplier by name once the API supplies one', async () => {
    // Finding 4.3 adds `vendorName` to the tenant-wide lists. This page
    // renders it when present and the code when not, so it is correct either
    // side of that change.
    renderPage(withAsns({ ...ASN, vendorName: 'Acme Industries Pvt Ltd' }));

    expect(await screen.findByText('Acme Industries Pvt Ltd')).toBeInTheDocument();
  });

  it('falls back to the vendor code when the API supplies no name', async () => {
    renderPage(withAsns(ASN));

    expect(await screen.findByText('vendor_test_001')).toBeInTheDocument();
  });
});

describe('an overdue shipment is called overdue', () => {
  it('marks a shipment past its own estimated delivery date', async () => {
    renderPage(withAsns({ ...ASN, estimatedDeliveryDate: '2020-01-01T00:00:00.000Z' }));

    await screen.findByText('ASN-826291');
    expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  });

  it('does not mark one that is still due', async () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();
    renderPage(withAsns({ ...ASN, estimatedDeliveryDate: future }));

    await screen.findByText('ASN-826291');
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('does not call a shipment with no estimate overdue', async () => {
    renderPage(withAsns({ ...ASN, estimatedDeliveryDate: null }));

    await screen.findByText('ASN-826291');
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });
});

describe('the Shipments nav entry', () => {
  it('is offered to a tenant role holding asn:read', () => {
    const hrefs = navFor(['workspace:read', 'asn:read'], 'tenant').map((item) => item.href);

    expect(hrefs).toContain('/workspace/shipments');
  });

  it('is not offered to a role without asn:read', () => {
    const hrefs = navFor(['workspace:read'], 'tenant').map((item) => item.href);

    expect(hrefs).not.toContain('/workspace/shipments');
  });

  it('is not offered on the supplier plane, which has its own shipments screen', () => {
    // A supplier holds asn:read too (config/permissions.js, VENDOR), so the
    // permission alone would show them a workspace tab. `plane` is the
    // non-bypassable second check — see workspaceNav.js's note.
    expect(navFor(['asn:read'], 'vendor')).toEqual([]);
  });
});
