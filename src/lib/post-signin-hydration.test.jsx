import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { usePortal } from '@/lib/portal-context';
import { renderWithPortal, navigation } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API, listOf } from '@/test/fixtures';

// PortalProvider is mounted once, at the root layout, and stays mounted
// across the /sign-in -> / navigation (issue #111). usePayments took no
// argument, so its mount effect depended only on stable useCallbacks and
// never re-ran once sign-in supplied a token — the dashboard's payments
// panel rendered its "No payments yet" empty state on every first paint
// after login, and only a manual reload fixed it.
//
// A direct page load with the token already in localStorage (what
// socket-events.test.jsx and the page-route suites render) cannot catch
// this: the mount effect runs once and answers correctly the very first
// time. Reproducing the bug needs the token to arrive *after* mount, same
// as a real sign-in.

const Probe = () => {
  const { state } = usePortal();
  return <div data-testid="payments">{state.payments === null ? 'loading' : state.payments.length}</div>;
};

const PAYMENT = {
  id: 'PMT-1',
  utrCode: 'UTR555',
  invoiceNumber: 'INV-1',
  paymentMethod: 'NEFT',
  grossAmount: 1000,
  tdsDeducted: 100,
  netAmount: 900,
  paymentDate: '2026-01-05T00:00:00.000Z',
};

describe('the dashboard after sign-in', () => {
  it('shows payments without a reload once the token arrives', async () => {
    const { apiMock, rerender } = renderWithPortal(<Probe />, {
      plane: 'supplier',
      route: '/sign-in',
      signedOut: true,
      api: {
        ...EMPTY_SUPPLIER_API,
        'GET /payments': listOf('payments', [PAYMENT]),
      },
    });

    // Before sign-in: no token, so nothing was fetched — and that has to
    // read as "not loaded yet", not as a confirmed empty payment history.
    expect(screen.getByTestId('payments')).toHaveTextContent('loading');
    expect(apiMock.callsTo('GET', '/payments')).toHaveLength(0);

    // Sign-in completes: sign-in/page.jsx writes the token and the cached
    // profile, then router.push('/') — PortalProvider does not remount for
    // any of that, since it lives above every route in the root layout.
    localStorage.setItem('jwt_token', 'test-token');
    localStorage.setItem('sap_vendor_profile_data', JSON.stringify({ vendorId: 'VND-00001' }));
    navigation.pathname = '/';
    rerender(<Probe />);

    await waitFor(() => expect(apiMock.callsTo('GET', '/payments').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('payments')).toHaveTextContent('1'));
  });
});
