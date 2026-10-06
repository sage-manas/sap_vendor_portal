import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithPortal, routeParams, OPERATOR_SESSION } from '@/test/renderWithPortal';
import { EMPTY_PLATFORM_API } from '@/test/fixtures';
import TenantDetailPage from '@/app/platform/tenants/[clientId]/page';

// Finding 4.4. `Client.gstin` and `Client.state` were real columns nothing
// could set — the schema said so outright ("Nullable because nothing sets them
// yet (no onboarding screen collects them)"). The consequence was in
// services/gst.service.js: with no `Client.state` there is no place of supply
// to derive, so every invoice's tax was split as "state unknown" rather than
// into CGST+SGST or IGST.
//
// The state is a select, not a text box, and that is the substance rather than
// a styling choice. `isIntraState` compares the tenant's state to the
// supplier's as trimmed, lower-cased strings, and the supplier picked theirs
// from a fixed list. An operator typing 'MH' stores a value that matches no
// supplier state, and the mis-split is silent. The server refuses anything
// off-registry; this makes that constraint visible in the form instead of
// arriving as a 400.

const STATES = {
  states: [
    { code: 'KA', name: 'Karnataka' },
    { code: 'MH', name: 'Maharashtra' },
    { code: 'TN', name: 'Tamil Nadu' },
  ],
};

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

// The page gates its Edit button on `can('tenant:manage')`, the same
// permission backend/routes/platform.routes.js requires on the PUT.
const MANAGING_OPERATOR = {
  ...OPERATOR_SESSION,
  auth: { ...OPERATOR_SESSION.auth, permissions: [...OPERATOR_SESSION.auth.permissions, 'tenant:manage'] },
};

const apiFor = (overrides = {}, statesBody = STATES) => ({
  ...EMPTY_PLATFORM_API,
  'GET /platform/auth/me': MANAGING_OPERATOR,
  'GET /platform/tenants/CLT-0001': {
    tenant: tenant(overrides),
    administrators: [],
    counts: {},
  },
  'GET /meta/indian-states': statesBody,
  'PUT /platform/tenants/CLT-0001': { success: true, tenant: tenant(overrides), message: 'Configuration updated.' },
});

const renderPage = (api) => renderWithPortal(
  <TenantDetailPage params={routeParams({ clientId: 'CLT-0001' })} />,
  { plane: 'platform', route: '/platform/tenants/CLT-0001', params: { clientId: 'CLT-0001' }, api },
);

const openEditor = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
};

describe('the tenant detail page shows the GST registration', () => {
  it('reads out a configured GSTIN and state', async () => {
    renderPage(apiFor({ gstin: '27AABCU9603R1ZM', state: 'Maharashtra' }));

    expect(await screen.findByText('27AABCU9603R1ZM')).toBeInTheDocument();
    expect(screen.getByText('Maharashtra')).toBeInTheDocument();
  });

  it('shows an em dash for a tenant with no registration on file', async () => {
    renderPage(apiFor());

    // Not a blank, and not a guess: nothing is on file, so no place of supply
    // can be derived for this tenant's invoices.
    const gstinTerm = await screen.findByText('GSTIN');
    expect(gstinTerm.parentElement).toHaveTextContent('—');
  });
});

describe('an operator sets the GST registration', () => {
  it('sends the GSTIN and the chosen state', async () => {
    const { apiMock } = renderPage(apiFor());
    await openEditor();

    await userEvent.type(screen.getByLabelText('GSTIN'), '27AABCU9603R1ZM');
    await userEvent.selectOptions(screen.getByLabelText('State (place of supply)'), 'Maharashtra');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/platform/tenants/CLT-0001')).toHaveLength(1));
    expect(apiMock.lastBody('PUT', '/platform/tenants/CLT-0001')).toMatchObject({
      gstin: '27AABCU9603R1ZM',
      state: 'Maharashtra',
    });
  });

  it('uppercases a GSTIN typed in lower case', async () => {
    const { apiMock } = renderPage(apiFor());
    await openEditor();

    await userEvent.type(screen.getByLabelText('GSTIN'), '27aabcu9603r1zm');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/platform/tenants/CLT-0001')).toHaveLength(1));
    // A GSTIN is uppercase. The server's regex is case-insensitive, so this is
    // about what gets stored and displayed, not about passing validation.
    expect(apiMock.lastBody('PUT', '/platform/tenants/CLT-0001').gstin).toBe('27AABCU9603R1ZM');
  });

  it('pre-fills the editor with what is already stored', async () => {
    renderPage(apiFor({ gstin: '29AABCU9603R1ZX', state: 'Karnataka' }));
    await openEditor();

    expect(screen.getByLabelText('GSTIN')).toHaveValue('29AABCU9603R1ZX');
    expect(screen.getByLabelText('State (place of supply)')).toHaveValue('Karnataka');
  });

  it('can clear a registration that was entered in error', async () => {
    const { apiMock } = renderPage(apiFor({ gstin: '27AABCU9603R1ZM', state: 'Maharashtra' }));
    await openEditor();

    await userEvent.clear(screen.getByLabelText('GSTIN'));
    await userEvent.selectOptions(screen.getByLabelText('State (place of supply)'), '');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(apiMock.callsTo('PUT', '/platform/tenants/CLT-0001')).toHaveLength(1));
    // '' rather than omitted — the server stores null for it, which is how a
    // registration is taken back out.
    expect(apiMock.lastBody('PUT', '/platform/tenants/CLT-0001')).toMatchObject({ gstin: '', state: '' });
  });
});

describe('the state field offers only states the server will accept', () => {
  it('offers every state the registry serves, plus "Not set"', async () => {
    renderPage(apiFor());
    await openEditor();

    const select = screen.getByLabelText('State (place of supply)');
    expect([...select.options].map((option) => option.value))
      .toEqual(['', 'Karnataka', 'Maharashtra', 'Tamil Nadu']);
  });

  it('takes its options from the server, not a copy in the page', async () => {
    // The whole point of GET /meta/indian-states. If the page held its own
    // list this would still show three states.
    renderPage(apiFor({}, { states: [{ code: 'GJ', name: 'Gujarat' }] }));
    await openEditor();

    const select = screen.getByLabelText('State (place of supply)');
    expect([...select.options].map((option) => option.value)).toEqual(['', 'Gujarat']);
  });

  it('says so, and disables the field, when the registry cannot be loaded', async () => {
    // An empty dropdown is indistinguishable from "there are no states to
    // pick", so a failure has to read as a failure.
    renderPage(apiFor({}, { status: 500, body: { error: 'boom' } }));
    await openEditor();

    expect(await screen.findByText(/could not load the state list/i)).toBeInTheDocument();
    expect(screen.getByLabelText('State (place of supply)')).toBeDisabled();
  });
});
