import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal } from '@/test/renderWithPortal';
import { EMPTY_PLATFORM_API } from '@/test/fixtures';

import PlatformHealthPage from '@/app/platform/page';
import PlatformTenantsPage from '@/app/platform/tenants/page';
import PlatformOperatorsPage from '@/app/platform/operators/page';
import PlatformAuditPage from '@/app/platform/audit/page';
import PlatformSapPage from '@/app/platform/sap/page';
import PlatformReconciliationPage from '@/app/platform/reconciliation/page';

// The platform console's routes, rendered past the MFA gate (OPERATOR_SESSION
// is enrolled and verified — see lib/platform-session.js's stageFor). The gate
// itself is covered separately in platform-gate.test.jsx.

const ROUTES = [
  ['/platform', PlatformHealthPage, 'Platform health'],
  ['/platform/tenants', PlatformTenantsPage, 'Tenants'],
  ['/platform/operators', PlatformOperatorsPage, 'Operators'],
  ['/platform/audit', PlatformAuditPage, 'Audit'],
  ['/platform/sap', PlatformSapPage, 'SAP connections'],
  ['/platform/reconciliation', PlatformReconciliationPage, 'Reconciliation'],
];

const settle = () => waitFor(() =>
  expect(screen.queryByText(/^(Loading|Reading)/i)).not.toBeInTheDocument());

describe.each(ROUTES)('%s', (route, Page, heading) => {
  it('renders its heading with nothing provisioned', async () => {
    renderWithPortal(<Page />, { plane: 'platform', route, api: EMPTY_PLATFORM_API });

    await settle();
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
  });

  it('asks only for endpoints the fixtures know about', async () => {
    const { apiMock } = renderWithPortal(<Page />, {
      plane: 'platform', route, api: EMPTY_PLATFORM_API,
    });

    await settle();
    expect(apiMock.unmatched).toEqual([]);
  });
});
