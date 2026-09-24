import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal, TENANT_SESSION } from '@/test/renderWithPortal';
import { EMPTY_WORKSPACE_API } from '@/test/fixtures';
import WorkspacePurchaseOrdersPage from '@/app/workspace/purchase-orders/page';
import WorkspaceNewAssetPoPage from '@/app/workspace/purchase-orders/new-asset/page';

// Issue #117. Raising an asset purchase order is the buying organisation's
// decision (ADR-0042) — finance holds po:read but not po:manage, and the
// "New asset PO" button used to render for them regardless, so the only
// place they learned it was never theirs was a 403 after filling in the
// whole form. Both the entry point and the form itself are gated on the same
// permission the server already enforces (config/permissions.js, PO_MANAGE
// is BUYER/CLIENT_ADMIN only) — the honest-UI rule this app follows
// everywhere: a hidden action and a refused request are the same rule.

const sessionWithout = (permission) => ({
  ...TENANT_SESSION,
  auth: {
    ...TENANT_SESSION.auth,
    permissions: TENANT_SESSION.auth.permissions.filter((p) => p !== permission),
  },
});

const sessionWith = (permission) => ({
  ...TENANT_SESSION,
  auth: {
    ...TENANT_SESSION.auth,
    permissions: [...TENANT_SESSION.auth.permissions, permission],
  },
});

const apiFor = (session) => ({ ...EMPTY_WORKSPACE_API, 'GET /auth/me': session });

describe('the "New asset PO" entry point', () => {
  it('is hidden from a role without po:manage', async () => {
    renderWithPortal(<WorkspacePurchaseOrdersPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders',
      api: apiFor(sessionWithout('po:manage')),
    });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Purchase Orders', level: 1 })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /new asset po/i })).not.toBeInTheDocument();
  });

  it('is shown to a role that holds po:manage', async () => {
    renderWithPortal(<WorkspacePurchaseOrdersPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders',
      api: apiFor(sessionWith('po:manage')),
    });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Purchase Orders', level: 1 })).toBeInTheDocument());
    expect(await screen.findByRole('button', { name: /new asset po/i })).toBeInTheDocument();
  });
});

describe('the New asset PO form, reached directly', () => {
  it('refuses a role without po:manage, without rendering the form', async () => {
    renderWithPortal(<WorkspaceNewAssetPoPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders/new-asset',
      api: apiFor(sessionWithout('po:manage')),
    });

    expect(await screen.findByText(/decision for the buying organisation/i)).toBeInTheDocument();
    // Nothing from the real form — no asset-number field, no "Create in SAP".
    expect(screen.queryByText(/asset number/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create in sap/i })).not.toBeInTheDocument();
  });

  it('renders the real form for a role that holds po:manage', async () => {
    renderWithPortal(<WorkspaceNewAssetPoPage />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders/new-asset',
      api: apiFor(sessionWith('po:manage')),
    });

    expect(await screen.findByRole('button', { name: /create in sap/i })).toBeInTheDocument();
    expect(screen.queryByText(/decision for the buying organisation/i)).not.toBeInTheDocument();
  });
});
