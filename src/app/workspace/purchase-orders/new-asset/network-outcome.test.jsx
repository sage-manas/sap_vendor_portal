import { describe, it, expect } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspaceNewAssetPoPage from '@/app/workspace/purchase-orders/new-asset/page';

// Issue #119. This is the one screen in the app that creates a real,
// irreversible document in SAP (ADR-0042). Before this fix, a dropped
// connection on submit looked identical to a clean rejection — the operator
// saw "The order was not created in SAP" whether or not that was true, and
// nothing stopped them clicking submit again on top of an order that may
// already exist.

const sessionWithManage = {
  ...TENANT_SESSION,
  auth: { ...TENANT_SESSION.auth, permissions: [...TENANT_SESSION.auth.permissions, 'po:manage'] },
};

const apiWith = (postRoute) => ({
  ...EMPTY_WORKSPACE_API,
  'GET /auth/me': sessionWithManage,
  'GET /vendors': { vendors: [{ vendorId: 'V1', companyName: 'Kaveri Forge', sapVendorCode: '1120250081' }] },
  'POST /pos/asset': postRoute,
});

// The form refuses to submit while required fields are empty, so a submit that
// is meant to reach the API has to be a complete one.
const fillForm = async () => {
  const supplier = await screen.findByRole('combobox');
  await screen.findByRole('option', { name: /kaveri forge/i });
  fireEvent.change(supplier, { target: { value: 'V1' } });
  const type = (label, value) =>
    fireEvent.change(screen.getByText(label, { selector: 'label' }).parentElement.querySelector('input'), { target: { value } });
  type('Company code', 'SSDN');
  type('Purchasing org', 'SSDN');
  type('Purchasing group', 'SDN');
  type('Description', 'Pump');
  type('Asset number', '000000000701');
  type('Plant', '1000');
  type('Unit price', '1000');
};

describe('creating an asset PO, when the connection drops', () => {
  it('shows an outcome-unknown screen, not "the order was not created", and does not offer the form again', async () => {
    renderWithPortal(<WorkspaceNewAssetPoPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders/new-asset',
      api: apiWith(() => { throw new TypeError('Failed to fetch'); }),
    });

    await fillForm();
    const submit = await screen.findByRole('button', { name: /create in sap/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/could not confirm the outcome/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/the order was not created in sap/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create in sap/i })).not.toBeInTheDocument();
  });

  it('still shows the ordinary refusal message for a real rejection from SAP', async () => {
    renderWithPortal(<WorkspaceNewAssetPoPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders/new-asset',
      api: apiWith({ status: 422, body: { error: 'Invalid asset number' } }),
    });

    await fillForm();
    const submit = await screen.findByRole('button', { name: /create in sap/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/invalid asset number/i)).toBeInTheDocument();
    });
    // Unlike the offline case, the form is still there — a genuine rejection
    // means SAP never created anything, so retrying after a fix is fine.
    expect(screen.getByRole('button', { name: /create in sap/i })).toBeInTheDocument();
  });
});

describe('creating an asset PO, with required fields empty', () => {
  it('marks the missing fields and does not call the API', async () => {
    let called = false;
    renderWithPortal(<WorkspaceNewAssetPoPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders/new-asset',
      api: apiWith(() => { called = true; return {}; }),
    });

    fireEvent.click(await screen.findByRole('button', { name: /create in sap/i }));

    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(called).toBe(false);
  });
});
