import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import SuppliersPage from '@/app/workspace/suppliers/page';

// Adding a supplier SAP already holds: the tenant names its existing vendor
// code, so approval links to that vendor master instead of creating a second
// one (backend/controllers/vendor.controller.js, confirmSapVendor).

const KAVERI = {
  'Legal entity name': 'Kaveri Forge & Fittings',
  'Contact email': 'accounts@kaveriforge.example.com',
  'Mobile / phone': '+91 9823456710',
  GSTIN: '27AAECK4821M1ZA',
  PAN: 'AAECK4821M',
  'Street address': 'Plot 14, MIDC Bhosari',
  City: 'Pune',
  State: 'Maharashtra',
  'PIN code': '411026',
};

const created = { pk: 'vendor-pk-9', vendorId: 'VND-20617', companyName: 'Kaveri Forge & Fittings', status: 'Draft', sapVendorCode: '1120250081' };

// Adding a supplier is gated on vendor:create, as the API route is.
const ADMIN_SESSION = {
  ...TENANT_SESSION,
  auth: { ...TENANT_SESSION.auth, permissions: [...TENANT_SESSION.auth.permissions, 'vendor:create'] },
};

const openForm = async (api) => {
  const rendered = renderWithPortal(<SuppliersPage />, {
    plane: 'workspace', route: '/workspace/suppliers', api: { ...api, 'GET /auth/me': ADMIN_SESSION },
  });
  await userEvent.click(await screen.findByRole('button', { name: /Add supplier/ }));
  for (const [label, value] of Object.entries(KAVERI)) {
    await userEvent.type(screen.getByLabelText(label, { exact: true }), value);
  }
  return rendered;
};

describe('adding a supplier SAP already holds', () => {
  it('sends the existing vendor code and says approval will not create another', async () => {
    const { apiMock } = await openForm({
      ...EMPTY_WORKSPACE_API,
      'POST /vendors': { status: 201, body: { success: true, vendor: created, sapLink: { sapVendorCode: '1120250081', documents: 12 } } },
    });

    await userEvent.type(screen.getByLabelText('Existing SAP vendor code (optional)'), ' 1120250081 ');
    await userEvent.click(screen.getByRole('button', { name: 'Create and email them' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/vendors')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/vendors').sapVendorCode).toBe('1120250081');
    expect(await screen.findByText(/Linked to SAP vendor 1120250081 \(12 documents found\)/)).toBeInTheDocument();
  });

  it('sends no code at all when the field is left empty', async () => {
    const { apiMock } = await openForm({
      ...EMPTY_WORKSPACE_API,
      'POST /vendors': { status: 201, body: { success: true, vendor: { ...created, sapVendorCode: null } } },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Create and email them' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/vendors')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/vendors')).not.toHaveProperty('sapVendorCode');
  });

  it('shows SAP\'s refusal against the code field', async () => {
    await openForm({
      ...EMPTY_WORKSPACE_API,
      'POST /vendors': {
        status: 400,
        body: {
          success: false,
          error: 'SAP holds no purchasing documents for vendor 9999999999, so it cannot be confirmed.',
          reason: 'sap_vendor_not_found',
          errors: { sapVendorCode: 'No documents found in SAP for 9999999999' },
        },
      },
    });

    await userEvent.type(screen.getByLabelText('Existing SAP vendor code (optional)'), '9999999999');
    await userEvent.click(screen.getByRole('button', { name: 'Create and email them' }));

    expect(await screen.findByText('No documents found in SAP for 9999999999')).toBeInTheDocument();
  });
});
