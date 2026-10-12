import { describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { screen, waitFor } from '@testing-library/react';
import { renderWithPortal, navigation } from '@/test/renderWithPortal';
import { EMPTY_SUPPLIER_API } from '@/test/fixtures';

// The session token lives in localStorage, which the server cannot read, so the
// provider only learns whether anyone is signed in after the first render.
// Before the gate, a signed-out visitor to a protected route (the dashboard at
// `/`) was painted that route's whole shell for a frame and *then* redirected
// to /sign-in. `mounted` counts every time the page body really mounted, so a
// page that appeared and was torn down again cannot pass as "never shown".

const mounted = vi.fn();

const Page = () => {
  useEffect(() => { mounted(); }, []);
  return <div data-testid="page">protected page</div>;
};

describe('a protected route before the session is known', () => {
  it('never renders for a signed-out visitor, who is sent to sign in', async () => {
    mounted.mockClear();
    renderWithPortal(<Page />, { plane: 'supplier', route: '/', signedOut: true });

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/sign-in'));
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(mounted).not.toHaveBeenCalled();
  });

  it('renders for a signed-in visitor', async () => {
    mounted.mockClear();
    renderWithPortal(<Page />, {
      plane: 'supplier',
      route: '/',
      api: EMPTY_SUPPLIER_API,
    });

    expect(await screen.findByTestId('page')).toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalledWith('/sign-in');
  });

  it('does not reveal the dashboard when a signed-out visitor navigates to it from sign-in', async () => {
    const { rerender } = renderWithPortal(<Page />, {
      plane: 'supplier',
      route: '/sign-in',
      signedOut: true,
    });
    // /sign-in is reachable without a session, so it is shown straight away.
    expect(screen.getByTestId('page')).toBeInTheDocument();

    navigation.pathname = '/';
    navigation.push.mockClear();
    rerender(<Page />);
    // Still no token: the dashboard must not appear on the way back round.
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/sign-in'));
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
  });
});

describe('routes that are reachable without a supplier session', () => {
  it.each([
    ['/sign-in'],
    ['/sign-up'],
    ['/forgot-password'],
    ['/accept-invitation'],
    ['/platform'],
    ['/platform/tenants'],
  ])('%s renders at once, signed out, with no redirect', (route) => {
    mounted.mockClear();
    renderWithPortal(<Page />, { plane: 'supplier', route, signedOut: true });

    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();
  });
});
