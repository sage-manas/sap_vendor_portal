import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, routeParams, OPERATOR_SESSION } from '@/test/renderWithPortal';
import { EMPTY_PLATFORM_API } from '@/test/fixtures';
import TenantsPage from '@/app/platform/tenants/page';
import TenantDetailPage from '@/app/platform/tenants/[clientId]/page';
import TenantSapPage from '@/app/platform/tenants/[clientId]/sap/page';

// Three things an operator hit in the console's provisioning path, each one
// found by walking it in a browser rather than by a test:
//
//   1. The workspace address dropped a typed hyphen on every keystroke, so
//      `acme-corp` could only ever be typed as `acmecorp`.
//   2. Emptying a limit sent 0, which the API refuses — "no limit" (null) was
//      not reachable at all.
//   3. Emptying a number field on the SAP form stored 0 rather than unsetting
//      it, and the per-endpoint timeouts buried the fields a connection needs.

const operatorWith = (...permissions) => ({
  ...OPERATOR_SESSION,
  auth: { ...OPERATOR_SESSION.auth, permissions: [...OPERATOR_SESSION.auth.permissions, ...permissions] },
});

const tenant = (overrides = {}) => ({
  clientId: 'CLT-0001',
  companyName: 'Nucleus Industries',
  slug: 'nucleus',
  status: 'Active',
  plan: 'growth',
  branding: { logo: null, primaryColor: null },
  gstin: null,
  state: null,
  featureFlags: {},
  limits: { vendors: 50, rfqsPerMonth: 100, storageMb: 1024 },
  createdBy: 'operator@example.com',
  createdAt: '2026-01-01T00:00:00.000Z',
  activatedAt: '2026-01-02T00:00:00.000Z',
  suspendedAt: null,
  terminatedAt: null,
  ...overrides,
});

describe('creating a workspace', () => {
  const api = {
    ...EMPTY_PLATFORM_API,
    'GET /platform/auth/me': operatorWith('tenant:manage'),
    'POST /platform/tenants': { status: 201, body: { success: true, tenant: tenant(), message: 'Workspace created.' } },
  };

  it('keeps a hyphen typed into the workspace address, and trims only the edges on submit', async () => {
    const { apiMock } = renderWithPortal(<TenantsPage />, { plane: 'platform', route: '/platform/tenants', api });

    await userEvent.click(await screen.findByRole('button', { name: /New workspace/ }));
    await userEvent.type(screen.getByLabelText(/Company name/), 'Acme Corp');
    const address = screen.getByLabelText(/Workspace address/);
    await userEvent.clear(address);
    await userEvent.type(address, 'acme-corp-');
    expect(address).toHaveValue('acme-corp-');

    await userEvent.type(screen.getByLabelText(/Administrator email/), 'ops@acme.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(apiMock.callsTo('POST', '/platform/tenants')).toHaveLength(1));
    expect(apiMock.lastBody('POST', '/platform/tenants').slug).toBe('acme-corp');
  });

  it('follows the company name until the address is edited', async () => {
    renderWithPortal(<TenantsPage />, { plane: 'platform', route: '/platform/tenants', api });

    await userEvent.click(await screen.findByRole('button', { name: /New workspace/ }));
    await userEvent.type(screen.getByLabelText(/Company name/), 'Tata & Sons Pvt. Ltd.');

    expect(screen.getByLabelText(/Workspace address/)).toHaveValue('tata-sons-pvt-ltd');
  });
});

describe('editing a tenant\'s limits', () => {
  const api = {
    ...EMPTY_PLATFORM_API,
    'GET /platform/auth/me': operatorWith('tenant:manage'),
    'GET /platform/tenants/CLT-0001': { tenant: tenant(), administrators: [], counts: {} },
    'GET /meta/indian-states': { states: [] },
    'PUT /platform/tenants/CLT-0001': { success: true, tenant: tenant(), message: 'Configuration updated.' },
  };

  const renderPage = (overrides = api) => renderWithPortal(
    <TenantDetailPage params={routeParams({ clientId: 'CLT-0001' })} />,
    { plane: 'platform', route: '/platform/tenants/CLT-0001', params: { clientId: 'CLT-0001' }, api: overrides },
  );

  it('sends an emptied limit as null (unlimited), not 0', async () => {
    const { apiMock } = renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByLabelText('Supplier limit'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/platform/tenants/CLT-0001')).toHaveLength(1));
    expect(apiMock.lastBody('PUT', '/platform/tenants/CLT-0001').limits).toEqual({ vendors: null, rfqsPerMonth: 100, storageMb: 1024 });
  });

  it('reads out a null limit as Unlimited', async () => {
    renderPage({
      ...api,
      'GET /platform/tenants/CLT-0001': { tenant: tenant({ limits: { vendors: null, rfqsPerMonth: 100, storageMb: 1024 } }), administrators: [], counts: {} },
    });

    expect(await screen.findByText('Unlimited')).toBeInTheDocument();
  });

  it('names every field a refused save got wrong, not only the first', async () => {
    renderPage({
      ...api,
      'PUT /platform/tenants/CLT-0001': {
        status: 400,
        body: { success: false, errors: { companyName: 'Company name must be at least 2 characters', 'limits.vendors': 'Supplier limit must be a whole number' } },
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Company name must be at least 2 characters · Supplier limit must be a whole number/)).toBeInTheDocument();
  });
});

describe('the SAP connection form', () => {
  const DRIVERS = [{
    key: 's4_odata',
    label: 'S/4HANA (OData)',
    description: 'S/4HANA through custom Z REST endpoints.',
    implemented: true,
    secretFields: [{ name: 'username', label: 'Technical user' }, { name: 'password', label: 'Password' }],
    configFields: [
      { name: 'baseUrl', label: 'Gateway base URL', type: 'text' },
      { name: 'timeoutMs', label: 'Request timeout (ms)', type: 'number', default: 10000 },
      { name: 'vendorCreateTimeoutMs', label: 'Timeout for vendorCreate (ms)', type: 'number', advanced: true },
    ],
  }];

  const api = {
    ...EMPTY_PLATFORM_API,
    'GET /platform/auth/me': operatorWith('sap:configure'),
    'GET /platform/tenants/CLT-0001/sap': {
      clientId: 'CLT-0001',
      companyName: 'Nucleus Industries',
      activeEnvironment: 'sandbox',
      drivers: DRIVERS,
      connections: [
        {
          environment: 'sandbox',
          connection: {
            driver: 's4_odata',
            config: { baseUrl: 'https://s4.example.com', timeoutMs: 15000 },
            configuredSecrets: ['password', 'username'],
            lastTest: null,
            active: true,
          },
        },
        { environment: 'production', connection: null },
      ],
    },
    'GET /platform/tenants/CLT-0001/sap/audit': { entries: [] },
    'PUT /platform/tenants/CLT-0001/sap/sandbox': { success: true, connection: {}, warnings: [] },
  };

  const renderPage = () => renderWithPortal(
    <TenantSapPage params={routeParams({ clientId: 'CLT-0001' })} />,
    { plane: 'platform', route: '/platform/tenants/CLT-0001/sap', params: { clientId: 'CLT-0001' }, api },
  );

  it('unsets an emptied number field instead of storing 0, and leaves stored credentials alone', async () => {
    const { apiMock } = renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.clear(screen.getByLabelText('Request timeout (ms)'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/platform/tenants/CLT-0001/sap/sandbox')).toHaveLength(1));
    const body = apiMock.lastBody('PUT', '/platform/tenants/CLT-0001/sap/sandbox');
    expect(body.config).toEqual({ baseUrl: 'https://s4.example.com' });
    expect(body.secrets).toEqual({});
  });

  it('folds the per-endpoint overrides away under Advanced', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const advanced = screen.getByText(/Advanced — per-endpoint timeouts \(1\)/).closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(advanced).toContainElement(screen.getByLabelText('Timeout for vendorCreate (ms)'));
    expect(advanced).not.toContainElement(screen.getByLabelText('Gateway base URL'));
  });
});
