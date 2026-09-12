import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal, routeParams } from '@/test/renderWithPortal';
import { EMPTY_PLATFORM_API, EMPTY_WORKSPACE_API, VENDOR_PROFILE } from '@/test/fixtures';

import TenantDetailPage from '@/app/platform/tenants/[clientId]/page';
import TenantSapPage from '@/app/platform/tenants/[clientId]/sap/page';
import SupplierDetailPage from '@/app/workspace/suppliers/[id]/page';
import WorkspacePurchaseOrderPage from '@/app/workspace/purchase-orders/[id]/page';

// The four dynamic routes. Unlike the index pages these title themselves from
// the record they loaded, so "renders its heading" is also the assertion that
// the record arrived and was read with the field names the API actually sends.
//
// Next hands `params` in as a promise these pages unwrap with React's
// `use()`; routeParams() supplies the shape that actually resolves under the
// test renderer — see its comment in the harness.

const TENANT = {
  clientId: 'CLT-0001',
  companyName: 'Nucleus Manufacturing',
  slug: 'legacy',
  plan: 'standard',
  status: 'Active',
  sapEnvironment: 'sandbox',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'operator@example.com',
  limits: {},
  usage: {},
  counts: {},
  admins: [],
  settings: {},
};

const PO = {
  id: 'PO-2026-0001',
  sapPoNumber: null,
  vendorId: 'VND-00001',
  vendorName: 'Test Supplier Pvt Ltd',
  status: 'Open',
  createdDate: '2026-01-01T00:00:00.000Z',
  acknowledgedAt: null,
  currency: 'INR',
  items: [],
  totalValue: 0,
};

describe('/platform/tenants/[clientId]', () => {
  it('titles itself with the tenant it loaded', async () => {
    renderWithPortal(<TenantDetailPage params={routeParams({ clientId: 'CLT-0001' })} />, {
      plane: 'platform',
      route: '/platform/tenants/CLT-0001',
      api: {
        ...EMPTY_PLATFORM_API,
        'GET /platform/tenants/CLT-0001': { tenant: TENANT, administrators: [], counts: {} },
      },
    });

    expect(await screen.findByRole('heading', { name: 'Nucleus Manufacturing', level: 1 }))
      .toBeInTheDocument();
  });
});

describe('/platform/tenants/[clientId]/sap', () => {
  it('renders the connection screen for a tenant with nothing configured', async () => {
    renderWithPortal(<TenantSapPage params={routeParams({ clientId: 'CLT-0001' })} />, {
      plane: 'platform',
      route: '/platform/tenants/CLT-0001/sap',
      api: {
        ...EMPTY_PLATFORM_API,
        'GET /platform/tenants/CLT-0001/sap': { connections: [], active: null },
        'GET /platform/tenants/CLT-0001/sap/audit': { entries: [] },
      },
    });

    await waitFor(() =>
      expect(screen.queryByText(/Loading SAP configuration/i)).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: /SAP connection/i, level: 1 }))
      .toBeInTheDocument();
  });
});

describe('/workspace/suppliers/[id]', () => {
  it('titles itself with the supplier it loaded', async () => {
    renderWithPortal(<SupplierDetailPage params={routeParams({ id: 'vendor-pk-1' })} />, {
      plane: 'workspace',
      route: '/workspace/suppliers/vendor-pk-1',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /vendors/vendor-pk-1': {
          vendor: VENDOR_PROFILE,
          awaitingDecision: false,
          // Shape from the supplier-detail handler in
          // backend/controllers/vendor.controller.js.
          activity: {
            purchaseOrders: { total: 0, value: 0, byStatus: {} },
            invoices: { total: 0, value: 0, byStatus: {} },
            payments: { total: 0, grossPaid: 0, netPaid: 0, tdsDeducted: 0 },
            rfqInvitations: 0,
            goodsReceipts: 0,
            shipments: 0,
          },
          recentOrders: [],
        },
      },
    });

    expect(await screen.findByRole('heading', { name: 'Test Supplier Pvt Ltd', level: 1 }))
      .toBeInTheDocument();
  });
});

describe('/workspace/purchase-orders/[id]', () => {
  it('titles itself with the order it loaded', async () => {
    renderWithPortal(<WorkspacePurchaseOrderPage params={routeParams({ id: 'PO-2026-0001' })} />, {
      plane: 'workspace',
      route: '/workspace/purchase-orders/PO-2026-0001',
      api: {
        ...EMPTY_WORKSPACE_API,
        'GET /pos/PO-2026-0001': PO,
        'GET /pos/PO-2026-0001/invoice-plan': { plan: null, lines: [] },
      },
    });

    expect(await screen.findByRole('heading', { name: 'PO-2026-0001', level: 1 }))
      .toBeInTheDocument();
  });
});
